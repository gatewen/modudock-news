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


def namespace(lane, kind=''):
    client_type = dict(classify=classify.Classifier, analysis=analyze.Analyzer,
                       events=events.EventMatcher, topics=topics.TopicMatcher, tone=topics.ToneClient)[lane]
    client = object.__new__(client_type)
    context = kind if lane == 'analysis' else None
    if lane == 'events':
        context = [events.Pair(('a', '', ''), ('b', '', ''), .5)]
    questions = client._questions(2 if lane in ('events', 'topics') else 1, context)
    # Exact prompts/criteria and decoder implementation, including thresholds.
    return digest([SCHEMA, lane, kind, classify.MODEL, questions,
                   inspect.getsource(client_type._decode), inspect.getsource(classify._choice),
                   classify.THRESHOLD, events.SAME_THRESHOLD])


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
                 interval=5, limits=None, max_bytes=MAX_BYTES, start_writer=True):
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
        self.revision = 0
        self.saved = 0
        self.seed_hint = None
        self.records = self._read()
        self.counts = Counter(row[0] for row in self.records.values())
        self.thread = None
        if start_writer:
            self.thread = threading.Thread(target=self._writer, name='news-cache', daemon=True)
            self.thread.start()

    def _warn(self):
        if not self.warned:
            self.warned = True
            self.log('answer cache: unavailable; using memory')

    def _valid(self, row):
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
                and 0 <= self.clock() - stamp < TTL
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
                if self._valid_seeds(hint) and (self.seed_hint is None or hint['at'] > self.seed_hint['at']):
                    self.seed_hint = hint
            return self._prune({self._key(row): row for row in obj['records'] if self._valid(row)})
        except FileNotFoundError:
            return OrderedDict()
        except (OSError, ValueError, RecursionError):
            self._warn()
            return OrderedDict()

    def _prune(self, records):
        kept = OrderedDict()
        counts = Counter()
        # Reserve the maximum five-fingerprint hint while producers may update it.
        size = len(encoded({'schema': SCHEMA, 'records': [], 'seeds': None})) + 512
        for key, row in sorted(records.items(), key=lambda entry: entry[1][4], reverse=True):
            if not self._valid(row) or counts[row[0]] >= self.limits[row[0]]:
                continue
            cost = len(encoded(row)) + 1
            if size + cost > self.max_bytes:
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
            self.records[key] = row
            # Bound memory immediately; encoding/filesystem remain off coordinator.
            if self.counts[lane] > self.limits[lane]:
                victim = next(k for k, r in self.records.items() if r[0] == lane)
                del self.records[victim]
                self.counts[lane] -= 1
            self.revision += 1
        self.wake.set()

    def _valid_seeds(self, hint):
        return (isinstance(hint, dict) and set(hint) == {'namespace', 'at', 'items'}
                and isinstance(hint['namespace'], str) and HEX.fullmatch(hint['namespace'])
                and type(hint['at']) in (int, float) and 0 <= self.clock() - hint['at'] < TTL
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

    def snapshot(self):
        with self.lock:
            return [deepcopy(row) for row in self.records.values() if self._valid(row)]

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
                disk = self._read()
                with self.lock:
                    revision = self.revision
                    local = dict(self.records)
                for key, row in local.items():
                    if key not in disk or disk[key][4] < row[4]:
                        disk[key] = row
                merged = self._prune(disk)
                with self.lock:
                    hint = deepcopy(self.seed_hint)
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
        rows = self.store.snapshot()
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
