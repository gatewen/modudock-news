"""Bounded answer-only disk cache. No news text, URLs or credentials on disk."""
from collections import OrderedDict, Counter
from copy import deepcopy
import fcntl
import hashlib
import inspect
import json
import math
import os
from pathlib import Path
import re
import stat
import tempfile
import threading
import time

if __package__:
    from . import classify, analyze, events, topics
    from .feedparse import dedup_key
else:
    import classify, analyze, events, topics
    from feedparse import dedup_key

TTL = 72 * 3600
MAX_FUTURE = 24 * 3600
TEMP_MAX_AGE = 10 * 60
TEMP_NAME = re.compile(r'^answers-[a-z0-9_]{8}\.tmp$')
MAX_BYTES = 16 * 1024 * 1024
LIMITS = dict(classify=4000, analysis=4000, events=20000, topics=20000, tone=4000)
SCHEMA = 1
HEX = re.compile(r'^[0-9a-f]{64}$')


def encoded(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def fingerprint(item):
    return digest(list(item))


# Fixed semantic probes: Chinese lengths/ranges, aliases, Latin/digits,
# punctuation, invisible separators and preserved ZWJ. No source-code hash.
TOPIC_TOKEN_PROBES = (
    '', '甲', '甲乙丙丁戊', '特朗普特習川普川習', 'a A ab Ab AI123 123 １２３ ＡＢ',
    '峰會，合作！A-B foo_bar', '\u3400\u3401\u4dbf\u4e00\u9fff\U00020000\U0003134f',
    *(f'峰{separator}會 AB{separator}CD' for separator in
      ('\u200b', '\u200c', '\u2060', '\ufeff', '\u200d')),
)


def namespace(lane, kind=''):
    client_type = dict(classify=classify.Classifier, analysis=analyze.Analyzer,
                       events=events.EventMatcher, topics=topics.TopicMatcher, tone=topics.ToneClient)[lane]
    client = object.__new__(client_type)
    context = kind if lane == 'analysis' else None
    if lane == 'events':
        context = [events.Pair(('a', '', ''), ('b', '', ''), .5)]
    questions = client._questions(2 if lane in ('events', 'topics') else 1, context)
    # Exact prompts/criteria and decoder implementation, including thresholds.
    version = [SCHEMA, lane, kind, classify.MODEL, questions,
                   inspect.getsource(client_type._decode), inspect.getsource(classify._choice),
                   classify.THRESHOLD, events.SAME_THRESHOLD]
    if lane == 'topics':
        # Cached true may bypass the feature gate only within this gate version.
        # Append only here so all other lanes keep their existing namespaces.
        version.append(['MIN_COMMON_FEATURES', topics.MIN_COMMON_FEATURES,
                        'MAX_FEATURE_DF', topics.MAX_FEATURE_DF,
                        [(title, sorted(topics.words(title))) for title in TOPIC_TOKEN_PROBES]])
    return digest(version)


def valid_value(lane, value):
    if lane in ('events', 'topics'):
        return type(value) is bool
    if lane == 'analysis':
        if not analyze.valid_analysis(value):
            return False
        kind = value.get('kind')
        return kind in analyze.QUESTION_SETS and set(value) == (
            {'kind', *analyze.QUESTION_SETS[kind]} | ({'dir_p'} if kind == 'finance' else set()))
    return isinstance(value, str) and value in (classify.CRITERIA if lane == 'classify' else topics.TONE_CRITERIA)


class AnswerCache:
    def __init__(self, directory, *, clock=time.time, log=lambda message: None,
                 interval=5, limits=None, max_bytes=MAX_BYTES, start_writer=True, trace=None):
        self.trace = trace
        self.directory = Path(directory)
        self.path = self.directory / 'answers.json'
        self.clock, self.log, self.interval = clock, log, interval
        self.limits, self.max_bytes = limits or LIMITS, max_bytes
        self.lock = threading.Lock()
        self.writing = threading.Lock()
        self.wake = threading.Event()
        self.urgent = threading.Event()
        self.disabled = False
        self.warned = False
        self.corrupt_warned = False
        self.read_warned = False
        self.revision = 0
        self.saved = 0
        self.seed_hint = None
        self.records = self._read()
        self.counts = Counter(row[0] for row in self.records.values())
        self.by_fingerprint = {}
        self.lane_fifo = {lane: OrderedDict() for lane in self.limits}
        self.time_bounds = {lane: (math.inf, -math.inf) for lane in self.limits}
        self.next_position = 0
        for key, row in self.records.items():
            self._index_row(key, row)
        self.thread = None
        if start_writer:
            self.thread = threading.Thread(target=self._writer, name='news-cache', daemon=True)
            self.thread.start()

    def _warn(self):
        if not self.warned:
            self.warned = True
            self.log('answer cache: unavailable; using memory')

    def _warn_corrupt(self):
        if not self.corrupt_warned:
            self.corrupt_warned = True
            self.log('answer cache: corrupt file ignored; will rebuild')

    def _warn_read(self):
        if not self.read_warned:
            self.read_warned = True
            self.log('answer cache: read failed; using available memory')

    @staticmethod
    def _time_rank(stamp, now):
        # Future entries are recoverable metadata, never preferred to an answer
        # obtained under the current clock. Compare timestamps within each group.
        return (stamp <= now, stamp)

    def _valid(self, row, *, retain_future=False):
        if not isinstance(row, list) or len(row) != 6:
            return False
        lane, ns, kind, ends, stamp, value = row
        return (isinstance(lane, str) and lane in self.limits
                and isinstance(ns, str) and HEX.fullmatch(ns)
                and isinstance(kind, str) and kind in ('', 'finance', 'world', 'politics')
                and (lane == 'analysis') == bool(kind)
                and isinstance(ends, list) and len(ends) == (2 if lane in ('events', 'topics') else 1)
                and all(isinstance(x, str) and HEX.fullmatch(x) for x in ends)
                and type(stamp) in (int, float) and math.isfinite(stamp)
                and (-MAX_FUTURE if retain_future else 0) <= self.clock() - stamp < TTL
                and valid_value(lane, value)
                and (lane != 'analysis' or value['kind'] == kind))

    @staticmethod
    def _key(row):
        return digest(row[:4])

    def _read(self):
        try:
            with self.path.open('rb') as stream:
                data = stream.read(self.max_bytes + 1)
            if len(data) > self.max_bytes:
                raise ValueError()
            obj = json.loads(data)
            if not isinstance(obj, dict) or obj.get('schema') != SCHEMA or not isinstance(obj.get('records'), list):
                return OrderedDict()
            if len(obj['records']) > sum(self.limits.values()):
                return OrderedDict()
            hint = obj.get('seeds')
            with self.lock:
                now = self.clock()
                if self._valid_seeds(hint, retain_future=True) and (
                        not self._valid_seeds(self.seed_hint, retain_future=True)
                        or self._time_rank(hint['at'], now) > self._time_rank(self.seed_hint['at'], now)):
                    self.seed_hint = hint
            if self.trace is not None:
                for row in obj['records']:
                    # Validate shape/value while allowing an expired timestamp
                    # solely for diagnostic evidence, never for cache reuse.
                    if isinstance(row, list) and len(row) == 6:
                        probe = list(row)
                        probe[4] = self.clock()
                        if self._valid(probe) and type(row[4]) in (int, float) and math.isfinite(row[4]):
                            self.trace.cache_row(row)
            return self._prune({self._key(row): row for row in obj['records'] if self._valid(row, retain_future=True)})
        except FileNotFoundError:
            return OrderedDict()
        except (ValueError, RecursionError):
            self._warn_corrupt()
            return OrderedDict()
        except OSError:
            self._warn_read()
            return OrderedDict()

    def _prune(self, records):
        kept = OrderedDict()
        counts = Counter()
        # Reserve the maximum five-fingerprint hint while producers may update it.
        size = len(encoded({'schema': SCHEMA, 'records': [], 'seeds': None})) + 512
        now = self.clock()
        for key, row in sorted(records.items(), key=lambda entry: self._time_rank(entry[1][4], now), reverse=True):
            if not self._valid(row, retain_future=True) or counts[row[0]] >= self.limits[row[0]]:
                if self.trace is not None:
                    self.trace.cache_row(row, evicted=True)
                continue
            cost = len(encoded(row)) + 1
            if size + cost > self.max_bytes:
                if self.trace is not None:
                    self.trace.cache_row(row, evicted=True)
                continue
            counts[row[0]] += 1
            size += cost
            kept[key] = row
        return OrderedDict(reversed(kept.items()))

    def put(self, lane, ns, kind, ends, value):
        row = [lane, ns, kind, sorted(ends) if lane == 'events' else list(ends), self.clock(), deepcopy(value)]
        if not self._valid(row):
            return
        key = self._key(row)
        with self.lock:
            old = self.records.get(key)
            if old is not None and self._valid(old):
                return  # Hits never extend TTL.
            if key not in self.records:
                self.counts[lane] += 1
            if self.trace is not None:
                self.trace.cache_row(row, acquired=True)
            if old is not None:
                self._unindex_row(key, old)
            self.records[key] = row
            self._index_row(key, row)
            self.records.move_to_end(key)  # A refreshed expired answer is newly acquired.
            # Bound memory immediately; encoding/filesystem remain off coordinator.
            if self.counts[lane] > self.limits[lane]:
                victim = self._victim(lane, self.clock())
                if self.trace is not None:
                    self.trace.cache_row(self.records[victim], evicted=True)
                self._unindex_row(victim, self.records[victim])
                del self.records[victim]
                self.counts[lane] -= 1
            self.revision += 1
        self.wake.set()

    def _victim(self, lane, now):
        fifo = self.lane_fifo[lane]
        head = next(iter(fifo))
        if not now - TTL < fifo[head] <= now:
            return head  # Normal ageing (or future head): O(1), even at capacity.
        low, high = self.time_bounds[lane]
        if now - TTL < low and high <= now:
            return head  # Common path: no scan, including other lanes.
        # Conservative bounds may include a removed timestamp. Only a possible
        # expiry/rollback takes this slow path, bounded by this lane's capacity.
        victim = None
        low, high = math.inf, -math.inf
        for key, stamp in fifo.items():
            if victim is None and not now - TTL < stamp <= now:
                victim = key
                continue
            low, high = min(low, stamp), max(high, stamp)
        self.time_bounds[lane] = low, high
        return victim if victim is not None else next(iter(fifo))

    def _valid_seeds(self, hint, *, retain_future=False):
        return (isinstance(hint, dict) and set(hint) == {'namespace', 'at', 'items'}
                and isinstance(hint['namespace'], str) and HEX.fullmatch(hint['namespace'])
                and type(hint['at']) in (int, float)
                and (-MAX_FUTURE if retain_future else 0) <= self.clock() - hint['at'] < TTL
                and isinstance(hint['items'], list) and len(hint['items']) <= 5
                and all(isinstance(fp, str) and HEX.fullmatch(fp) for fp in hint['items']))

    def seeds(self, ns):
        with self.lock:
            return list(self.seed_hint['items']) if (self._valid_seeds(self.seed_hint)
                        and self.seed_hint['namespace'] == ns) else []

    def remember_seeds(self, ns, fingerprints):
        with self.lock:
            if (self._valid_seeds(self.seed_hint) and self.seed_hint['namespace'] == ns
                    and self.seed_hint['items'] == list(fingerprints)[:5]):
                return
            hint = dict(namespace=ns, at=self.clock(), items=list(fingerprints)[:5])
            if not self._valid_seeds(hint):
                return
            self.seed_hint = hint
            self.revision += 1
        self.wake.set()

    def _index_row(self, key, row):
        # Same lock as records; indexes contain only opaque keys, no news text.
        # A pair can be restored only if BOTH endpoints are selected. Indexing
        # its first endpoint is sufficient; projection still checks every end.
        self.by_fingerprint.setdefault(row[3][0], {})[key] = self.next_position
        self.next_position += 1
        lane, stamp = row[0], row[4]
        self.lane_fifo[lane][key] = stamp
        low, high = self.time_bounds[lane]
        self.time_bounds[lane] = min(low, stamp), max(high, stamp)

    def _unindex_row(self, key, row):
        lane = row[0]
        del self.lane_fifo[lane][key]
        if not self.lane_fifo[lane]:
            self.time_bounds[lane] = math.inf, -math.inf
        fp = row[3][0]
        bucket = self.by_fingerprint[fp]
        del bucket[key]
        if not bucket:
            del self.by_fingerprint[fp]

    def snapshot(self, fingerprints=None):
        with self.lock:
            if fingerprints is None:
                rows = self.records.values()
            else:
                selected = set(fingerprints)
                candidates = {}
                for fp in selected:
                    candidates.update(self.by_fingerprint.get(fp, {}))
                # Preserve original FIFO order without scanning unrelated rows.
                keys = sorted((key for key in candidates if all(fp in selected for fp in self.records[key][3])),
                              key=candidates.__getitem__)
                rows = (self.records[key] for key in keys)
            return [deepcopy(row) for row in rows if self._valid(row)]

    def _clean_temps(self):
        # Caller holds the process flock. Never remove a peer's current temp,
        # another filename, symlink or directory; bye may leave old regular files.
        cutoff = self.clock() - TEMP_MAX_AGE
        with os.scandir(self.directory) as entries:
            for entry in entries:
                if not TEMP_NAME.fullmatch(entry.name):
                    continue
                try:
                    info = entry.stat(follow_symlinks=False)
                    if stat.S_ISREG(info.st_mode) and info.st_mtime < cutoff:
                        os.unlink(entry.path)
                except FileNotFoundError:
                    pass

    def flush(self):
        """Writer only (public for deterministic tests); never block on a peer."""
        if self.disabled or not self.writing.acquire(blocking=False):
            return False
        temp = None
        try:
            self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            fd = os.open(self.directory / 'writer.lock', os.O_CREAT | os.O_RDWR, 0o600)
            with os.fdopen(fd, 'wb') as lockfile:
                try:
                    fcntl.flock(lockfile, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    return False
                self._clean_temps()
                disk = self._read()
                with self.lock:
                    revision = self.revision
                    local = dict(self.records)
                now = self.clock()
                for key, row in local.items():
                    if not self._valid(row, retain_future=True):
                        continue
                    if key not in disk or self._time_rank(disk[key][4], now) < self._time_rank(row[4], now):
                        disk[key] = row
                merged = self._prune(disk)
                with self.lock:
                    hint = deepcopy(self.seed_hint) if self._valid_seeds(self.seed_hint, retain_future=True) else None
                data = encoded({'schema': SCHEMA, 'records': list(merged.values()), 'seeds': hint})
                if len(data) > self.max_bytes:
                    raise OSError('cache capacity')
                fd, temp = tempfile.mkstemp(prefix='answers-', suffix='.tmp', dir=self.directory)
                with os.fdopen(fd, 'wb') as stream:
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temp, self.path)
                temp = None
                with self.lock:
                    self.saved = revision
                return True
        except OSError:
            self.disabled = True
            self._warn()
            return False
        finally:
            if temp is not None:
                try:
                    os.unlink(temp)
                except OSError:
                    pass
            self.writing.release()

    def request_flush(self):
        self.urgent.set()
        self.wake.set()

    def _writer(self):
        while True:
            self.wake.wait()
            self.wake.clear()
            self.urgent.wait(self.interval)
            self.urgent.clear()
            self.flush()
            with self.lock:
                dirty = self.revision != self.saved
            if dirty and not self.disabled:
                self.wake.set()


class CacheBridge:
    """Coordinator-only adapter between opaque disk keys and current news keys."""
    def __init__(self, store):
        self.store = store
        self.namespaces = {(lane, kind): namespace(lane, kind)
                           for lane in LIMITS
                           for kind in (analyze.QUESTION_SETS if lane == 'analysis' else [''])}
        self.current = {}
        self.restored_seeds = False
        self.validate_loaded_seeds = False

    @staticmethod
    def caches(scheduler):
        return dict(classify=scheduler.classify_cache, analysis=scheduler.analysis_cache,
                    events=scheduler.event_cache, topics=scheduler.topic_cache, tone=scheduler.tone_cache)

    def restore(self, scheduler, items):
        self.current = {dedup_key(i['link']): fingerprint((dedup_key(i['link']), i['title'], i['summary'])) for i in items}
        reverse = {fp: key for key, fp in self.current.items()}
        if not self.restored_seeds:
            scheduler.last_topic_seeds = tuple(reverse[fp] for fp in self.store.seeds(self.namespaces['topics', '']) if fp in reverse)
            self.restored_seeds = True
            self.validate_loaded_seeds = True
        caches = self.caches(scheduler)
        # Refresh all bounded in-memory answers, so TTL/content/version changes
        # cannot be bypassed by their legacy dedup-key-only representation.
        for cache in caches.values():
            cache.clear()
        rows = self.store.snapshot(reverse)
        for lane, ns, kind, ends, stamp, value in rows:
            if ns != self.namespaces.get((lane, kind)) or any(end not in reverse for end in ends):
                continue
            keys = [reverse[end] for end in ends]
            key = frozenset(keys) if lane == 'events' else tuple(keys) if lane == 'topics' else keys[0]
            # Analysis kind is selected after all classifications are restored.
            if lane != 'analysis':
                caches[lane][key] = value
        for lane, ns, kind, ends, stamp, value in rows:
            if lane == 'analysis' and ns == self.namespaces.get((lane, kind)) and ends[0] in reverse:
                key = reverse[ends[0]]
                if kind == analyze.analysis_kind(scheduler.classify_cache.get(key)):
                    caches[lane][key] = value

    def validate_seeds(self, scheduler, items, groups):
        if not self.validate_loaded_seeds:
            return
        outlets = scheduler._outlets()
        sources = {}
        for item in items:
            key = dedup_key(item['link'])
            sources.setdefault(groups[key]['event'], set()).add(outlets.get(item['source'], item['source']))
        scheduler.last_topic_seeds = tuple(key for key in scheduler.last_topic_seeds
            if key in groups and len(sources[groups[key]['event']]) >= 3)
        self.validate_loaded_seeds = False

    def remember_seeds(self, scheduler, body):
        if body['events']['pending'] or body['topics']['pending']:
            return
        self.store.remember_seeds(self.namespaces['topics', ''],
            [self.current[key] for key in scheduler.last_topic_seeds if key in self.current])

    def accept(self, candidate):
        provenance = getattr(candidate, 'cache_provenance', None)
        if provenance is None:
            return
        lane, kind, entries, attribute = provenance
        answers = getattr(candidate, attribute)
        ns = self.namespaces[lane, kind]
        for key, value in list(answers.items()):
            inputs = entries[key]
            ends = [fingerprint(item) for item in inputs]
            self.store.put(lane, ns, kind, ends, value)
            if any(self.current.get(item[0]) != fp for item, fp in zip(inputs, ends)):
                # The old successful answer remains useful on disk, but must
                # never decorate an edited same-link story in this process.
                del answers[key]
