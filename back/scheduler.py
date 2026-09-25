"""Fixed daemon workers, one cache-owning coordinator, bounded work/results.

Workers return detached candidate state. Only the coordinator commits it.
source_timeout starts when a worker takes a job; queued jobs are bounded by
round_timeout. stop never joins blocked network workers.
"""
from collections import OrderedDict, deque
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime, timezone
from hashlib import sha1
import queue
import sys
import threading
import time

if __package__:
    from .feedparse import parse_feed, merge_items, fit_packet, dedup_key, MAX_ITEMS_LIST
    from .classify import CRITERIA, MAX_ITEMS, MAX_CHARS
    from .analyze import ANALYSIS_CATEGORIES, valid_analysis, analysis_kind
    from .events import candidate_pairs, group_events, _fits as pairs_fit
    from .topics import plan as topic_plan, TopicPair, fits as topics_fit
else:
    from feedparse import parse_feed, merge_items, fit_packet, dedup_key, MAX_ITEMS_LIST
    from classify import CRITERIA, MAX_ITEMS, MAX_CHARS
    from analyze import ANALYSIS_CATEGORIES, valid_analysis, analysis_kind
    from events import candidate_pairs, group_events, _fits as pairs_fit
    from topics import plan as topic_plan, TopicPair, fits as topics_fit


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


@dataclass
class ModelRound:
    round_id: int
    deadline: float | None = None  # Starts with this round's first model request.
    failed: bool = False


@dataclass
class EventResult:
    matches: dict = field(default_factory=dict)
    finished: tuple = ()
    round_id: int = 0


@dataclass
class TopicResult:
    matches: dict = field(default_factory=dict)
    finished: tuple = ()
    round_id: int = 0


@dataclass
class AnalysisResult:
    analyses: dict = field(default_factory=dict)
    finished: tuple = ()
    round_id: int = 0


@dataclass
class ClassifyResult:
    categories: dict = field(default_factory=dict)
    finished: tuple = ()  # Failed/unattempted keys also need an acknowledgement.
    round_id: int = 0  # Diagnostic provenance only; never an acceptance guard.
    items: tuple = ()
    work: ModelRound | None = None


class Scheduler:
    def __init__(self, feeds, fetcher, outbox, seq, *, interval=600,
                 source_timeout=30, round_timeout=60, clock=time.monotonic,
                 now=lambda: datetime.now(timezone.utc), fit=fit_packet, log=None, classifier=None, analyzer=None, matcher=None, topic_matcher=None):
        if not 1 <= len(feeds) <= 32 or min(interval, source_timeout, round_timeout) <= 0:
            raise ValueError("invalid scheduler limits")
        self.feeds, self.fetcher, self.outbox, self.seq = deepcopy(feeds), fetcher, outbox, seq
        self.interval, self.source_timeout, self.round_timeout = interval, source_timeout, round_timeout
        self.clock, self.now, self.fit = clock, now, fit
        self.log = log or (lambda message: print(message, file=sys.stderr, flush=True))
        self.cv = threading.Condition()
        self.jobs = queue.Queue(maxsize=32)
        self.classifier = classifier
        self.analyzer = analyzer
        self.matcher = matcher
        self.topic_matcher = topic_matcher
        self.topic_jobs = queue.Queue(maxsize=MAX_ITEMS_LIST)
        self.topic_cache = OrderedDict()
        self.topic_in_flight = set()
        self.model_work = None
        self.event_jobs = queue.Queue(maxsize=MAX_ITEMS_LIST * 2)
        self.event_cache = OrderedDict()
        self.event_in_flight = set()
        self.model_clock = getattr(classifier, "clock", clock)
        self.model_budget = getattr(classifier, "budget", 60)
        self.analysis_jobs = queue.Queue(maxsize=MAX_ITEMS_LIST)
        self.analysis_cache = OrderedDict()
        self.analysis_in_flight = set()
        self.classify_jobs = queue.Queue(maxsize=MAX_ITEMS_LIST)
        self.classify_cache = OrderedDict()
        self.in_flight = set()  # Coordinator-owned, including queued work.
        self.last_list = None
        self.last_topic_seeds = ()
        self.classify_worker = (threading.Thread(target=self._classify_worker,
                                name="news-classify", daemon=True)
                                if self._classify_enabled() else None)
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
        if self.classify_worker is not None:
            self.classify_worker.start()
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

    def _classify_enabled(self):
        clients = [client for client in (self.classifier, self.analyzer, self.matcher, self.topic_matcher) if client is not None]
        if any(not client.enabled for client in clients):
            for client in clients:
                client.enabled = False
        return self.classifier is not None and self.classifier.enabled

    def _enqueue_classification(self, packet):
        # Called by the coordinator after list + publish, outside the emit
        # path. cv protects admission/dedup; put_nowait never waits for space.
        with self.cv:
            if self.stopping or not self._classify_enabled():
                return
            work = ModelRound(self.round_id)
            self.model_work = work
            for item in packet["body"]["items"]:
                key = dedup_key(item["link"])
                self._enqueue_analysis(work, (key, item["title"], item["summary"]))
                if item["category"] or key in self.classify_cache or key in self.in_flight:
                    continue
                try:
                    self.classify_jobs.put_nowait((work, (key, item["title"], item["summary"])))
                except queue.Full:
                    continue
                self.in_flight.add(key)
            if self.matcher is not None:
                for pair in candidate_pairs(packet["body"]["items"]):
                    if pair.automatic or pair.key in self.event_cache or pair.key in self.event_in_flight:
                        continue
                    try:
                        self.event_jobs.put_nowait((work, pair))
                    except queue.Full:
                        continue
                    self.event_in_flight.add(pair.key)
            self._enqueue_topics(packet)
            self.cv.notify_all()

    def _submit_classification(self, result):
        with self.cv:
            while not self.stopping and len(self.results) >= 32:
                self.cv.wait()
            if self.stopping:
                return False
            self.results.append(result)
            self.cv.notify_all()
            return True

    def _cached_analysis(self, key):
        # Coordinator only, under cv. Classification and analysis FIFO caches
        # can evict independently, so a reclassified key may change kind.
        analysis = self.analysis_cache.get(key)
        category = self.classify_cache.get(key, "")
        if category not in ANALYSIS_CATEGORIES:
            return None  # Unknown category (e.g. evicted): keep the entry for later.
        if analysis is not None and analysis.get("kind", "finance") != analysis_kind(category):
            del self.analysis_cache[key]
            return None
        return analysis

    def _enqueue_analysis(self, work, item):
        # Coordinator only, under cv; work carries the shared original budget.
        key = item[0]
        category = self.classify_cache.get(key, "")
        cached = self._cached_analysis(key)
        if category not in ANALYSIS_CATEGORIES:
            return
        if (self.analyzer is None or self.stopping or not self._classify_enabled()
                or work.failed or (work.deadline is not None and self.model_clock() >= work.deadline)
                or cached is not None or key in self.analysis_in_flight):
            return
        try:
            self.analysis_jobs.put_nowait((work, item))
        except queue.Full:
            return
        self.analysis_in_flight.add(key)
        self.cv.notify_all()

    def _classify_worker(self):
        # Reconsider priority at every HTTP batch boundary. In-flight HTTP is
        # not preemptible. Queue/results/work references all remain bounded.
        while True:
            with self.cv:
                while not self.stopping and (
                    (self.classify_jobs.empty() and self.analysis_jobs.empty() and self.event_jobs.empty() and self.topic_jobs.empty())
                    or any(isinstance(result, ClassifyResult) for result in self.results)
                ):
                    self.cv.wait()
                if self.stopping:
                    return
                jobs = (self.classify_jobs if not self.classify_jobs.empty() else
                        self.analysis_jobs if not self.analysis_jobs.empty() else
                        self.event_jobs if not self.event_jobs.empty() else self.topic_jobs)
                topic_matching = jobs is self.topic_jobs
                matching = jobs is self.event_jobs
                analyzing = jobs is self.analysis_jobs
                work, item = jobs.get_nowait()
                kind = analysis_kind(self.classify_cache.get(item[0], "")) if analyzing else None
                batch = [item]
                chars = 0 if matching or topic_matching else len(item[1]) + len(item[2])
                if analyzing:
                    # Leave other kinds in their original positions/order.
                    # cv owns admission; the queue mutex protects its storage.
                    with jobs.mutex:
                        index = 0
                        while index < len(jobs.queue) and len(batch) < MAX_ITEMS:
                            next_work, next_item = jobs.queue[index]
                            if next_work is not work:
                                break
                            if analysis_kind(self.classify_cache.get(next_item[0], "")) != kind:
                                index += 1
                                continue
                            size = len(next_item[1]) + len(next_item[2])
                            if chars + size > MAX_CHARS:
                                break
                            batch.append(next_item)
                            chars += size
                            del jobs.queue[index]
                        jobs.not_full.notify_all()
                while not analyzing and not jobs.empty() and (matching or topic_matching or len(batch) < MAX_ITEMS):
                    with jobs.mutex:
                        next_work, next_item = jobs.queue[0]
                    size = 0 if matching or topic_matching else len(next_item[1]) + len(next_item[2])
                    if (next_work is not work
                            or (matching and not pairs_fit(batch + [next_item]))
                            or (topic_matching and not topics_fit(batch + [next_item]))
                            or chars + size > MAX_CHARS):
                        break
                    batch.append(jobs.get_nowait()[1])
                    chars += size
                if work.deadline is None:
                    work.deadline = self.model_clock() + self.model_budget
                allowed = self._classify_enabled() and not work.failed and self.model_clock() < work.deadline
            result = None
            if allowed:
                try:
                    result = (self.topic_matcher.match(batch) if topic_matching else self.matcher.match(batch) if matching else
                              self.analyzer.analyze(batch, kind=kind) if analyzing else self.classifier.classify(batch))
                except Exception:
                    self.log("classify: worker failed")  # Never expose secret-bearing exceptions.
            with self.cv:
                if result is None:
                    work.failed = True
            keys = tuple(pair.key for pair in batch) if matching or topic_matching else tuple(key for key, _, _ in batch)
            if topic_matching:
                candidate = TopicResult(result or {}, keys, work.round_id)
            elif matching:
                candidate = EventResult(result or {}, keys, work.round_id)
            elif analyzing:
                candidate = AnalysisResult(result or {}, keys, work.round_id)
            else:
                candidate = ClassifyResult(result or {}, keys, work.round_id, tuple(batch), work)
            if not self._submit_classification(candidate):
                return

    def _decorate(self, packet):
        # Coordinator only, under cv. Never mutate parser/source caches.
        packet = deepcopy(packet)
        body = packet["body"]
        for item in body["items"]:
            key = dedup_key(item["link"])
            item["category"] = self.classify_cache.get(key, "")
            item["analysis"] = (deepcopy(self._cached_analysis(key))
                                if self._classify_enabled() and item["category"] in ANALYSIS_CATEGORIES else None)
        enabled = self._classify_enabled()
        body["classify"] = {"enabled": enabled,
                            "pending": sum(not i["category"] for i in body["items"]) if enabled else 0}
        body["analysis"] = {"pending": sum(i["category"] in ANALYSIS_CATEGORIES
                              and i["analysis"] is None for i in body["items"]) if enabled else 0}
        return self._decorate_events(packet)

    def _cache_events(self, matches):
        # Coordinator only, under cv. False is a successful answer too.
        for key, same in matches.items():
            if isinstance(key, frozenset) and len(key) == 2 and type(same) is bool:
                self.event_cache[key] = same
                if len(self.event_cache) > 20000:
                    self.event_cache.popitem(last=False)

    def _decorate_events(self, packet):
        body = packet["body"]
        pairs = candidate_pairs(body["items"])
        # Automatic edges may outnumber the FIFO capacity; derive evicted ones
        # locally as well so they never become pending work or lose grouping.
        matches = {pair.key: True for pair in pairs if pair.automatic}
        matches.update(self.event_cache)
        groups = group_events(body["items"], matches, [feed["name"] for feed in self.feeds])
        for item in body["items"]:
            item.update(groups[dedup_key(item["link"])])
        body["events"] = {"pending": sum(not pair.automatic and pair.key not in self.event_cache for pair in pairs)
                          if self._classify_enabled() and self.matcher is not None else 0}
        return self._decorate_topics(packet, groups)

    def _topic_plan(self, packet, groups=None):
        items = packet['body']['items']
        if groups is None:
            groups = {dedup_key(i['link']): {'event': i['event']} for i in items}
        return topic_plan(items, groups, self.topic_cache, [f['name'] for f in self.feeds], self.last_topic_seeds)

    def _decorate_topics(self, packet, groups):
        body = packet['body']
        topics, pending = self._topic_plan(packet, groups)
        membership = {key: topic['id'] for topic in topics for key in topic['keys']}
        for item in body['items']:
            item.pop('topic', None)
            key = dedup_key(item['link'])
            if key in membership:
                item['topic'] = membership[key]
        body['topics'] = {'pending': len(pending) if self._classify_enabled()
                          and self.topic_matcher is not None and body['events']['pending'] == 0 else 0,
                          'list': [{k: v for k, v in topic.items() if k != 'keys'} for topic in topics]}
        return packet

    def _enqueue_topics(self, packet):
        # Coordinator only. Reuse this list's admission budget across snowball steps.
        work = self.model_work
        if (self.topic_matcher is None or work is None or self.stopping or work.failed
                or not self._classify_enabled() or packet['body']['events']['pending'] != 0
                or (work.deadline is not None and self.model_clock() >= work.deadline)):
            return
        _, pending = self._topic_plan(packet)
        records = {dedup_key(i['link']): (dedup_key(i['link']), i['title'], i['summary']) for i in packet['body']['items']}
        for seed, key in pending:
            if (seed, key) in self.topic_in_flight:
                continue
            try:
                self.topic_jobs.put_nowait((work, TopicPair(records[seed], records[key])))
            except queue.Full:
                break
            self.topic_in_flight.add((seed, key))
        self.cv.notify_all()

    def _model_resend(self, accepted):
        if not self.active and self.last_list is not None:
            body = self.last_list["body"]
            visible = {dedup_key(item["link"]) for item in body["items"]}
            if accepted & visible or body["classify"]["enabled"] != self._classify_enabled():
                return self._decorate(self.last_list)
        return None

    def _accept(self, candidate):
        # Called only under cv by the coordinator. A worker produces exactly
        # one candidate per job; the generation check is the ownership guard.
        self.processed_results += 1
        if isinstance(candidate, TopicResult):
            self.topic_in_flight.difference_update(candidate.finished)
            self.topic_in_flight.difference_update(candidate.matches)
            for key, same in candidate.matches.items():
                if isinstance(key, tuple) and len(key) == 2 and type(same) is bool:
                    self.topic_cache[key] = same
                    if len(self.topic_cache) > 20000:
                        self.topic_cache.popitem(last=False)
            if not self.active and self.last_list is not None:
                packet = self._decorate(self.last_list)
                self._enqueue_topics(packet)
                old, new = self.last_list['body'], packet['body']
                changed = (old.get('topics', {}).get('list') != new['topics']['list']
                           or [i.get('topic') for i in old['items']] != [i.get('topic') for i in new['items']])
                cleared = old.get('topics', {}).get('pending', 0) > 0 and new['topics']['pending'] == 0
                if changed or cleared:
                    return packet
                return self._model_resend(set())
            return None
        if isinstance(candidate, EventResult):
            self.event_in_flight.difference_update(candidate.finished)
            self.event_in_flight.difference_update(candidate.matches)
            self._cache_events(candidate.matches)
            if not self.active and self.last_list is not None:
                packet = self._decorate(self.last_list)
                self._enqueue_topics(packet)
                old = [(i["event"], i["event_size"]) for i in self.last_list["body"]["items"]]
                new = [(i["event"], i["event_size"]) for i in packet["body"]["items"]]
                pending_cleared = (self.last_list["body"]["events"]["pending"] > 0
                                   and packet["body"]["events"]["pending"] == 0)
                if old != new or pending_cleared:
                    return packet
                # Authentication shutdown must still reach all model consumers.
                return self._model_resend(set())
            return None
        if isinstance(candidate, AnalysisResult):
            self.analysis_in_flight.difference_update(candidate.finished)
            self.analysis_in_flight.difference_update(candidate.analyses)
            accepted = set()
            for key, analysis in candidate.analyses.items():
                if (valid_analysis(analysis)
                        and analysis.get("kind", "finance") == analysis_kind(self.classify_cache.get(key, ""))):
                    self.analysis_cache[key] = deepcopy(analysis)
                    accepted.add(key)
                    if len(self.analysis_cache) > 4000:
                        self.analysis_cache.popitem(last=False)
            return self._model_resend(accepted)
        if isinstance(candidate, ClassifyResult):
            self.in_flight.difference_update(candidate.finished)
            self.in_flight.difference_update(candidate.categories)
            accepted = set()
            for key, category in candidate.categories.items():
                if isinstance(category, str) and category in CRITERIA:
                    self.classify_cache[key] = category
                    accepted.add(key)
                    if len(self.classify_cache) > 4000:
                        self.classify_cache.popitem(last=False)
            if candidate.work is not None:
                for item in candidate.items:
                    if item[0] in accepted:
                        self._enqueue_analysis(candidate.work, item)
            # Model results belong to keys, never fetch generations.
            return self._model_resend(accepted)
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

    def _send_list(self, packet, publish=False):
        # Serialization and output must stay outside cv so stop never waits
        # for an expensive fit or a blocked output sink.
        try:
            item_count = len(packet["body"]["items"])
            packet = self.fit(packet)
            with self.cv:
                # Fit can remove a representative or whole pair; recount only
                # the actually emitted items. IDs have fixed length and sizes
                # were reserved to three digits during fitting.
                packet = self._decorate_events(packet)
            if not publish and len(packet["body"]["items"]) < item_count:
                self.log("classify: resend unexpectedly trimmed items")
            if self.outbox.put(packet):
                with self.cv:
                    self.last_list = deepcopy(packet)
                    keys = [dedup_key(item['link']) for item in packet['body']['items']]
                    seeds = {sha1(key.encode('utf-8')).hexdigest()[:12]: key for key in keys}
                    # A seed trimmed by fit simply stops being sticky.
                    self.last_topic_seeds = tuple(seeds[topic['id']] for topic in packet['body'].get('topics', {}).get('list', [])
                                                  if topic.get('id') in seeds)
                if publish:
                    self.outbox.put({"t": "publish", "seq": self.seq, "topic": "news.fetched",
                                     "body": {"count": len(packet["body"]["items"]),
                                              "at": packet["body"]["at"]}})
                return packet
        except ValueError as exc:
            self.log("list packet rejected: " + str(exc)[:200])
        return None

    def _emit(self, caches, statuses):
        packet = {"t": "msg", "seq": self.seq, "body": {
            "op": "list", "items": merge_items([cache.items for cache in caches]),
            "sources": statuses, "at": self.now().isoformat()}}
        with self.cv:
            self._cache_events({pair.key: True for pair in candidate_pairs(packet["body"]["items"])
                                if pair.automatic and pair.key not in self.event_cache})
            packet = self._decorate(packet)
        return self._send_list(packet, publish=True)

    def _run(self):
        while True:
            resends = []
            completed = None
            with self.cv:
                if self.stopping:
                    return
                if not self.active and (self.pending_refresh or self.clock() >= self.next_round):
                    self._begin()
                while self.results:
                    packet = self._accept(self.results.popleft())
                    if packet is not None:
                        resends[:] = [packet]
                self.cv.notify_all()
                if self.active:
                    now = self.clock()
                    for i in list(self.pending):
                        if now >= min(self.round_end, self.deadlines.get(i, self.round_end)):
                            self.status[i].update(ok=False, error="deadline")
                            self.pending.remove(i)
                    if not self.pending:
                        completed = deepcopy(self.caches), deepcopy(self.status)
                    else:
                        due = min([self.round_end] + [self.deadlines[i] for i in self.pending if i in self.deadlines])
                else:
                    due = self.next_round
                if completed is None and not resends:
                    self.cv.wait(max(0, due - self.clock()))
                    continue
            for packet in resends:
                self._send_list(packet)
            if completed is not None:
                packet = self._emit(*completed)
                if packet is not None:
                    self._enqueue_classification(packet)
                with self.cv:
                    self.active = False
                    self.completed += 1
                    self.next_round = self.clock() + self.interval
                    self.cv.notify_all()
