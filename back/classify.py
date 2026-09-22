"""Synchronous jev client; the scheduler owns threads, queues and caches.

classify(batch) returns a complete key -> category candidate or None.
classify_round(items) yields successful batches, stopping at the first failure
or before starting another request once 60 seconds have elapsed. Inputs are
(key, title, summary) tuples. Consume the iterator on one classifier worker;
do not call this object concurrently. Each new iterator is a new round.

The budget is admission-only: an in-flight request can finish after it expires.
Socket timeouts cannot reclaim a worker stuck in DNS or trickling headers.
"""
import http.client
import json
import os
import sys
import time
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


class Classifier:
    def __init__(self, *, endpoint=ENDPOINT, key=None, clock=time.monotonic,
                 timeout=15, budget=60, ssl_context=None, ca_file=None, log=None):
        if timeout <= 0 or budget <= 0:
            raise ValueError("timeouts must be positive")
        parts = urlsplit(endpoint)
        if (parts.scheme not in ("http", "https") or not parts.hostname
                or parts.username is not None or parts.password is not None
                or any(ord(c) <= 32 or ord(c) == 127 for c in endpoint)):
            raise ValueError("invalid classifier endpoint")
        self.endpoint = endpoint
        self._key = os.environ.get("TYPESAFE_API_KEY", "") if key is None else key
        self.enabled = bool(self._key)
        self.clock, self.timeout, self.budget = clock, timeout, budget
        self.log = log or (lambda message: print(message, file=sys.stderr, flush=True))
        # Reuse the exact CA fallback and verification policy without applying
        # the RSS destination/redirect policy or doing any network I/O.
        tls = Fetcher(ssl_context=ssl_context, ca_file=ca_file)
        self.ssl_context, self.has_ca = tls.ssl_context, tls.has_ca
        self._opener = build_opener(ProxyHandler({}),
                                   HTTPSHandler(context=self.ssl_context), _NoRedirect())
        if not self.enabled:
            self.log("classify: disabled (no TYPESAFE_API_KEY)")

    def classify_round(self, items):
        """Yield detached successful candidates; never retry within this round."""
        started = self.clock()
        batch, chars = [], 0
        for item in items:
            if not self.enabled or self.clock() - started >= self.budget:
                return
            key, title, summary = item
            size = len(title) + len(summary)
            if size > MAX_CHARS:
                self.log("classify: item exceeds character limit")
                return
            if batch and (len(batch) == MAX_ITEMS or chars + size > MAX_CHARS):
                result = self.classify(batch)
                if result is None:
                    return
                yield result
                if self.clock() - started >= self.budget:
                    return
                batch, chars = [], 0
            batch.append((key, title, summary))
            chars += size
        if batch and self.enabled and self.clock() - started < self.budget:
            result = self.classify(batch)
            if result is not None:
                yield result

    def classify(self, batch):
        """One bounded HTTP batch. None means disabled or whole-batch failure."""
        if not self.enabled:
            return None
        batch = list(batch)
        if not batch:
            return {}
        if len(batch) > MAX_ITEMS or sum(len(t) + len(s) for _, t, s in batch) > MAX_CHARS:
            self.log("classify: batch exceeds limit")
            return None
        if urlsplit(self.endpoint).scheme == "https" and not self.has_ca:
            self.log("classify: no CA certificates")
            return None
        payload = {
            "model": MODEL,
            "state": {f"news_{i}": {"title": title, "summary": summary}
                      for i, (_, title, summary) in enumerate(batch)},
            "questions": {f"item_{i}": {"type": "choice", "instructions": f"news_{i} 這則新聞屬於哪一類？",
                                        "criteria": CRITERIA} for i in range(len(batch))},
        }
        try:
            request = Request(self.endpoint, data=json.dumps(payload).encode("utf-8"),
                              headers={"Authorization": "Bearer " + self._key,
                                       "Content-Type": "application/json", "User-Agent": USER_AGENT},
                              method="POST")
            try:
                response = self._opener.open(request, timeout=self.timeout)
            except HTTPError as exc:
                response = exc
            with response:
                if response.code in (401, 403):
                    self.enabled = False
                    self.log(f"classify: disabled (HTTP {response.code})")
                    return None
                if response.code != 200:
                    self.log(f"classify: HTTP {response.code}")
                    return None
                data = bytearray()
                while True:
                    block = response.read1(min(65536, MAX_BODY + 1 - len(data)))
                    if not block:
                        if response.length not in (None, 0):
                            raise _InvalidResponse()
                        break
                    data.extend(block)
                    if len(data) > MAX_BODY:
                        raise _InvalidResponse()
            document = json.loads(data)
            if not isinstance(document, dict) or not isinstance(document.get("answers"), dict):
                raise _InvalidResponse()
            answers = document["answers"]
            result = {}
            for i, (key, _, _) in enumerate(batch):
                answer = answers.get(f"item_{i}")
                if not isinstance(answer, dict):
                    raise _InvalidResponse()
                choice, probabilities = answer.get("choice"), answer.get("probabilities")
                if not isinstance(choice, str) or choice not in CRITERIA:
                    raise _InvalidResponse()
                if not isinstance(probabilities, dict) or not probabilities:
                    raise _InvalidResponse()
                if any(type(p) not in (int, float) or not 0 <= p <= 1
                       for p in probabilities.values()):
                    raise _InvalidResponse()
                result[key] = "other" if max(probabilities.values()) < THRESHOLD else choice
            return result
        except (OSError, URLError, ValueError, http.client.HTTPException, RecursionError):
            # Never log exception text, response content or request headers:
            # any of them could contain the secret (including an echoed key).
            self.log("classify: request or response failed")
            return None
