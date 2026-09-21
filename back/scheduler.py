"""Fixed daemon workers, one cache-owning coordinator, bounded work/results.

Workers return detached candidate state. Only the coordinator commits it.
source_timeout starts when a worker takes a job; queued jobs are bounded by
round_timeout. stop never joins blocked network workers.
"""
from collections import OrderedDict, deque
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime, timezone
import queue
import sys
import threading
import time

if __package__:
    from .feedparse import parse_feed, merge_items, fit_packet
else:
    from feedparse import parse_feed, merge_items, fit_packet


@dataclass
class Cache:
    items: list = field(default_factory=list)
    validators: dict = field(default_factory=dict)
    first_seen: OrderedDict = field(default_factory=OrderedDict)
    available: bool = False


@dataclass
class Candidate:
    round_id: int
    index: int
    cache: Cache | None = None
    error: str | None = None
    clear_validators: bool = False


class Scheduler:
    def __init__(self, feeds, fetcher, outbox, seq, *, interval=600,
                 source_timeout=30, round_timeout=60, clock=time.monotonic,
                 now=lambda: datetime.now(timezone.utc), fit=fit_packet, log=None):
        if not 1 <= len(feeds) <= 32 or min(interval, source_timeout, round_timeout) <= 0:
            raise ValueError("invalid scheduler limits")
        self.feeds, self.fetcher, self.outbox, self.seq = deepcopy(feeds), fetcher, outbox, seq
        self.interval, self.source_timeout, self.round_timeout = interval, source_timeout, round_timeout
        self.clock, self.now, self.fit = clock, now, fit
        self.log = log or (lambda message: print(message, file=sys.stderr, flush=True))
        self.cv = threading.Condition()
        self.jobs = queue.Queue(maxsize=32)
        self.results = deque()  # Producers wait at 32; no unbounded late results.
        self.caches = [Cache() for _ in feeds]
        self.stopping = False
        self.active = False
        self.pending_refresh = False
        self.round_id = 0
        self.completed = 0
        self.processed_results = 0
        self.dropped_results = 0
        self.next_round = 0
        self.workers = [threading.Thread(target=self._worker, name=f"news-fetch-{i}", daemon=True) for i in range(4)]
        self.coordinator = threading.Thread(target=self._run, name="news-coordinator", daemon=True)

    def start(self):
        for worker in self.workers:
            worker.start()
        self.coordinator.start()

    def refresh(self):
        with self.cv:
            if not self.stopping:
                self.pending_refresh = True
                self.cv.notify_all()

    def stop(self):
        with self.cv:
            self.stopping = True
            self.cv.notify_all()

    def snapshot(self):
        with self.cv:
            return deepcopy(self.caches)

    def _begin(self):
        self.round_id += 1
        self.active = True
        self.pending_refresh = False
        self.round_end = self.clock() + self.round_timeout
        self.pending = set(range(len(self.feeds)))
        self.deadlines = {}
        self.status = [{"name": f["name"], "ok": False, "error": None, "count": 0} for f in self.feeds]
        while True:
            try:
                self.jobs.get_nowait()
            except queue.Empty:
                break
        for i, cache in enumerate(self.caches):
            self.jobs.put_nowait((self.round_id, i, deepcopy(cache)))
        self.cv.notify_all()

    def _worker(self):
        while True:
            with self.cv:
                while not self.stopping and self.jobs.empty():
                    self.cv.wait()
                if self.stopping:
                    return
                rid, i, cache = self.jobs.get_nowait()
                if rid != self.round_id or not self.active or self.clock() >= self.round_end:
                    continue
                self.deadlines[i] = self.clock() + self.source_timeout
                self.cv.notify_all()
            feed = self.feeds[i]
            self.log(f"fetching round={rid} source={i}")
            candidate = Candidate(rid, i)
            try:
                result = self.fetcher.fetch(feed["url"], cache.validators)
                if result.status == "ok":
                    items, seen = parse_feed(result.data_bytes, result.final_url, feed["name"], cache.first_seen, self.now())
                    candidate.cache = Cache(items, deepcopy(result.validators), seen, True)
                elif result.status == "not_modified":
                    if cache.available:
                        candidate.cache = cache
                    else:
                        candidate.error = "304 without cache"
                        candidate.clear_validators = True
                else:
                    candidate.error = result.error[:200]
            except Exception as exc:
                candidate.error = ("fetch/parse: " + str(exc))[:200]
            with self.cv:
                while not self.stopping and len(self.results) >= 32:
                    self.cv.wait()
                if self.stopping:
                    return
                self.results.append(candidate)
                self.cv.notify_all()

    def _accept(self, candidate):
        # Called only under cv by the coordinator. A worker produces exactly
        # one candidate per job; the generation check is the ownership guard.
        self.processed_results += 1
        if candidate.round_id != self.round_id:
            self.dropped_results += 1
            return
        i = candidate.index
        if not self.active or self.clock() >= min(self.round_end, self.deadlines.get(i, self.round_end)):
            self.dropped_results += 1
            return
        if candidate.cache is not None:
            self.caches[i] = candidate.cache  # All three cache components together.
        elif candidate.clear_validators:
            self.caches[i] = Cache(self.caches[i].items, {}, self.caches[i].first_seen, self.caches[i].available)
        self.status[i].update(ok=candidate.error is None, error=candidate.error)
        self.pending.discard(i)

    def _emit(self, caches, statuses):
        at = self.now().isoformat()
        packet = {"t": "msg", "seq": self.seq, "body": {
            "op": "list", "items": merge_items([cache.items for cache in caches]),
            "sources": statuses, "at": at}}
        try:
            packet = self.fit(packet)
            if self.outbox.put(packet):
                self.outbox.put({"t": "publish", "seq": self.seq, "topic": "news.fetched",
                                 "body": {"count": len(packet["body"]["items"]), "at": at}})
        except ValueError as exc:
            self.log("list packet rejected: " + str(exc)[:200])

    def _run(self):
        while True:
            with self.cv:
                if self.stopping:
                    return
                if not self.active and (self.pending_refresh or self.clock() >= self.next_round):
                    self._begin()
                while self.results:
                    self._accept(self.results.popleft())
                self.cv.notify_all()
                if self.active:
                    now = self.clock()
                    for i in list(self.pending):
                        if now >= min(self.round_end, self.deadlines.get(i, self.round_end)):
                            self.status[i].update(ok=False, error="deadline")
                            self.pending.remove(i)
                    if not self.pending:
                        caches, statuses = deepcopy(self.caches), deepcopy(self.status)
                    else:
                        due = min([self.round_end] + [self.deadlines[i] for i in self.pending if i in self.deadlines])
                        self.cv.wait(max(0, due - self.clock()))
                        continue
                else:
                    self.cv.wait(max(0, self.next_round - self.clock()))
                    continue
            # Serialization / output never hold cv: bye must not wait for them.
            self._emit(caches, statuses)
            with self.cv:
                self.active = False
                self.completed += 1
                self.next_round = self.clock() + self.interval
                self.cv.notify_all()
