"""Synchronous jev client; the scheduler owns threads, queues and caches.

classify(batch) returns a complete key -> category candidate or None.
classify_round(items) yields successful batches, stopping at the first failure
or before starting another request once 60 seconds have elapsed. Inputs are
(key, title, summary) tuples. Request context and round state are local to each call, so clients can be
called concurrently. Each new iterator is a new round.

The budget is admission-only: an in-flight request can finish after it expires.
Body reads check a total response deadline starting before the request (30s
by default). This is cooperative between socket reads; DNS and slow headers
still cannot be reclaimed, and a blocked read waits for its socket timeout.
"""
from dataclasses import dataclass, field
from contextvars import ContextVar
import http.client
import json
import os
import sys
import time
import threading
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPSHandler, HTTPRedirectHandler, ProxyHandler, Request, build_opener

if __package__:
    from .fetch import Fetcher, USER_AGENT
else:
    from fetch import Fetcher, USER_AGENT

ENDPOINT = "https://api.typesafe.ai/v1/systemone"
MODEL = "jev-1.13.0"
MAX_ITEMS = 20
MAX_CHARS = 8000
MAX_BODY = 1024 * 1024
THRESHOLD = 0.35
# Per worker invocation, not shared mutable client state; no payload/key exposure.
_http_observer = ContextVar("news_http_observer", default=None)
_failure_detail = ContextVar("news_failure_detail", default="other")
CRITERIA = {
    "politics": "台灣或各國政府、選舉、政黨、法案、外交",
    "finance": "股匯市、經濟數據、企業財報與併購、房市、產業景氣（科技公司的財報歸這裡）",
    "tech": "產品、技術、AI、半導體技術本身、網路服務（不含財報）",
    "world": "國外的社會事件、戰爭、災難、國際組織（外交歸政治）",
    "society": "台灣的治安、司法案件、事故、災害、公共安全",
    "life": "健康、醫療、教育、消費、旅遊、天氣、交通",
    "sports": "各項運動賽事、球員、賽果",
    "entertainment": "影視、音樂、藝人、遊戲、綜藝",
    "other": "以上皆非",
}


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class _InvalidResponse(ValueError):
    pass


class _ResponseDeadline(Exception):
    pass


@dataclass
class _ClientState:
    enabled: bool
    reason: str = ""
    lock: object = field(default_factory=threading.Lock, repr=False)


class _ChoiceClient:
    """Shared transport, bounded batching and atomic choice validation."""

    _label = "classify"
    def __init__(self, *, endpoint=ENDPOINT, key=None, clock=time.monotonic,
                 timeout=15, budget=60, read_deadline=30, sleep=time.sleep, ssl_context=None, ca_file=None, log=None, shared=None):
        if shared is not None:
            # One authentication switch and the exact same HTTP/TLS settings.
            for name in ("endpoint", "_key", "clock", "timeout", "budget", "read_deadline", "sleep", "log",
                         "ssl_context", "has_ca", "_opener", "_state"):
                setattr(self, name, getattr(shared, name))
            return
        if timeout <= 0 or budget <= 0 or read_deadline <= 0:
            raise ValueError("timeouts must be positive")
        parts = urlsplit(endpoint)
        if (parts.scheme not in ("http", "https") or not parts.hostname
                or parts.username is not None or parts.password is not None
                or any(ord(c) <= 32 or ord(c) == 127 for c in endpoint)):
            raise ValueError("invalid classifier endpoint")
        self.endpoint = endpoint
        self._key = os.environ.get("TYPESAFE_API_KEY", "") if key is None else key
        self._state = _ClientState(bool(self._key), "" if self._key else "no_key")
        self.clock, self.timeout, self.budget = clock, timeout, budget
        self.read_deadline = read_deadline
        self.sleep = sleep
        self.log = log or (lambda message: print(message, file=sys.stderr, flush=True))
        # Reuse the exact CA fallback and verification policy without applying
        # the RSS destination/redirect policy or doing any network I/O.
        tls = Fetcher(ssl_context=ssl_context, ca_file=ca_file)
        self.ssl_context, self.has_ca = tls.ssl_context, tls.has_ca
        self._opener = build_opener(ProxyHandler({}),
                                   HTTPSHandler(context=self.ssl_context), _NoRedirect())
        if not self.enabled:
            self.log(f"{self._label}: disabled (no TYPESAFE_API_KEY)")

    @property
    def enabled(self):
        with self._state.lock:
            return self._state.enabled

    @enabled.setter
    def enabled(self, value):
        # Shared clients use the same lock; authentication shutdown is visible
        # to subsequent admissions without holding a lock during network I/O.
        with self._state.lock:
            if self._state.enabled and not value:
                self._state.reason = "auth"
            self._state.enabled = value

    @property
    def disabled_reason(self):
        with self._state.lock:
            return self._state.reason

    def _run_round(self, items, request):
        """Yield detached successful candidates; stop at a failed batch (rate-limit retries are request-local)."""
        started = self.clock()
        batch, chars = [], 0
        for item in items:
            if not self.enabled or self.clock() - started >= self.budget:
                return
            key, title, summary = item
            size = len(title) + len(summary)
            if size > MAX_CHARS:
                self.log(f"{self._label}: item exceeds character limit")
                return
            if batch and (len(batch) == MAX_ITEMS or chars + size > MAX_CHARS):
                result = request(batch)
                if result is None:
                    return
                yield result
                if self.clock() - started >= self.budget:
                    return
                batch, chars = [], 0
            batch.append((key, title, summary))
            chars += size
        if batch and self.enabled and self.clock() - started < self.budget:
            result = request(batch)
            if result is not None:
                yield result

    def _request(self, batch, context=None):
        """One bounded HTTP batch. None means disabled or whole-batch failure."""
        if not self.enabled:
            return None
        batch = list(batch)
        if not batch:
            return {}
        if len(batch) > MAX_ITEMS or sum(len(t) + len(s) for _, t, s in batch) > MAX_CHARS:
            self.log(f"{self._label}: batch exceeds limit")
            return None
        if urlsplit(self.endpoint).scheme == "https" and not self.has_ca:
            self.log(f"{self._label}: no CA certificates")
            return None
        payload = {
            "model": MODEL,
            "state": {f"news_{i}": {"title": title, "summary": summary}
                      for i, (_, title, summary) in enumerate(batch)},
            "questions": self._questions(len(batch), context),
        }
        try:
            request = Request(self.endpoint, data=json.dumps(payload).encode("utf-8"),
                              headers={"Authorization": "Bearer " + self._key,
                                       "Content-Type": "application/json", "User-Agent": USER_AGENT},
                              method="POST")
            deadline = self.clock() + self.read_deadline
            for attempt in range(3):
                if not self.enabled:
                    return None
                observer = _http_observer.get()
                if observer is not None:
                    observer(attempt > 0)
                try:
                    response = self._opener.open(request, timeout=self.timeout)
                except HTTPError as exc:
                    response = exc
                with response:
                    if response.code in (401, 403):
                        self.enabled = False
                        self.log(f"{self._label}: disabled (HTTP {response.code})")
                        return None
                    if response.code in (429, 529):
                        limited = True
                    elif response.code != 200:
                        self.log(f"{self._label}: HTTP {response.code}")
                        return None
                    else:
                        limited = False
                        data = bytearray()
                        while True:
                            if self.clock() >= deadline:
                                raise _ResponseDeadline()
                            block = response.read1(min(65536, MAX_BODY + 1 - len(data)))
                            if self.clock() >= deadline:
                                raise _ResponseDeadline()
                            if not block:
                                if response.length not in (None, 0):
                                    raise _InvalidResponse()
                                break
                            data.extend(block)
                            if len(data) > MAX_BODY:
                                raise _InvalidResponse()
                if not limited:
                    break
                delay = 0.5 * (2 ** attempt)
                if attempt == 2 or self.clock() + delay >= deadline:
                    self.log(f"{self._label}: rate limited")
                    _failure_detail.set("busy")
                    return None
                self.log(f"{self._label}: rate limited, retry")
                self.sleep(delay)
                if self.clock() >= deadline:
                    self.log(f"{self._label}: rate limited")
                    _failure_detail.set("busy")
                    return None
            document = json.loads(data)
            if not isinstance(document, dict) or not isinstance(document.get("answers"), dict):
                raise _InvalidResponse()
            return self._decode(batch, document["answers"], context)
        except _ResponseDeadline:
            _failure_detail.set("connection")
            self.log(f"{self._label}: response deadline")
            return None
        except (OSError, URLError, http.client.HTTPException):
            _failure_detail.set("connection")
            self.log(f"{self._label}: request or response failed")
            return None
        except (ValueError, RecursionError):
            _failure_detail.set("response")
            # Never log exception text, response content or request headers:
            # any of them could contain the secret (including an echoed key).
            self.log(f"{self._label}: request or response failed")
            return None


def _choice(answer, criteria, abstain):
    """Validate one answer; return its thresholded choice and raw p_max."""
    if not isinstance(answer, dict):
        raise _InvalidResponse()
    choice, probabilities = answer.get("choice"), answer.get("probabilities")
    if not isinstance(choice, str) or choice not in criteria:
        raise _InvalidResponse()
    if not isinstance(probabilities, dict) or not probabilities:
        raise _InvalidResponse()
    if any(type(p) not in (int, float) or not 0 <= p <= 1
           for p in probabilities.values()):
        raise _InvalidResponse()
    p_max = max(probabilities.values())
    return (abstain if p_max < THRESHOLD else choice), p_max


class Classifier(_ChoiceClient):
    def classify_round(self, items):
        return self._run_round(items, self.classify)

    def classify(self, batch):
        return self._request(batch)

    def _questions(self, size, context=None):
        return {f"item_{i}": {"type": "choice", "instructions": f"news_{i} 這則新聞屬於哪一類？",
                              "criteria": CRITERIA} for i in range(size)}

    def _decode(self, batch, answers, context=None):
        return {key: _choice(answers.get(f"item_{i}"), CRITERIA, "other")[0]
                for i, (key, _, _) in enumerate(batch)}
