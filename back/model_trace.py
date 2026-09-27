"""Opt-in, bounded diagnostic metadata. Never serialize request text or URLs.

Absence of evidence is 'other', not an inferred cache eviction. Knowledge is
bounded and process-local; enabling trace does not change model decisions.
"""
from collections import OrderedDict
from datetime import datetime, timezone
import fcntl
import os
from pathlib import Path
import stat
import threading
import time

if __package__:
    from .answer_cache import digest, fingerprint, encoded, namespace, TTL, MAX_FUTURE
    from .analyze import QUESTION_SETS
    from .feedparse import dedup_key
else:
    from answer_cache import digest, fingerprint, encoded, namespace, TTL, MAX_FUTURE
    from analyze import QUESTION_SETS
    from feedparse import dedup_key

MAX_BYTES = 20 * 1024 * 1024  # Active + one rotated file, each at most half.
MAX_KNOWLEDGE = 52000


def optional_trace(directory, **options):
    try:
        enabled = (Path(directory) / 'trace.enable').is_file()
    except OSError:
        enabled = False
    return ModelTrace(directory, **options) if enabled else None


class ModelTrace:
    def __init__(self, directory, *, clock=time.time, log=lambda _: None, max_bytes=MAX_BYTES):
        self.directory = Path(directory)
        self.clock, self.log, self.max_bytes = clock, log, max_bytes
        self.lock = threading.Lock()
        self.io_lock = threading.Lock()
        self.disabled = False
        self.versions, self.causes, self.answers, self.seeds = (OrderedDict() for _ in range(4))
        self.namespaces = {(lane, kind): namespace(lane, kind)
            for lane in ('classify', 'analysis', 'events', 'topics', 'tone')
            for kind in (QUESTION_SETS if lane == 'analysis' else [''])}

    @staticmethod
    def _remember(table, key, value):
        table[key] = value
        table.move_to_end(key)
        while len(table) > MAX_KNOWLEDGE:
            table.popitem(last=False)

    def cache_row(self, row, *, evicted=False, acquired=False):
        lane, ns, kind, ends, stamp, _ = row
        if ns != self.namespaces.get((lane, kind)):
            return
        now = self.clock()
        age = now - stamp
        if age < -MAX_FUTURE:
            return
        key = digest([lane, ns, kind, ends])
        with self.lock:
            previous = self.answers.get(key)
            if previous and (((previous[0] <= now, previous[0]) > (stamp <= now, stamp)
                    and not acquired) or (previous[0] == stamp
                    and previous[1] == 'cache_evicted' and not evicted and not acquired)):
                return  # A flush reading an older disk snapshot is not a new acquisition.
            reason = 'cache_expired' if age >= TTL else 'cache_evicted' if evicted else 'other'
            self._remember(self.answers, key, (stamp, reason))
            for fp in ends:
                # Existing fingerprints prove this is not a first observed item.
                if fp not in self.causes:
                    self._remember(self.causes, fp, 'other')
            if lane == 'topics':
                self._remember(self.seeds, ends[0], True)

    def items(self, items):
        current = {}
        with self.lock:
            for item in items:
                key = dedup_key(item['link'])
                ident = digest(key)
                fp = fingerprint((key, item['title'], item['summary']))
                previous = self.versions.get(ident)
                cause = ('content_changed' if previous is not None and previous != fp
                         else self.causes.get(fp, 'new_item'))
                self._remember(self.versions, ident, fp)
                self._remember(self.causes, fp, cause)
                current[fp] = cause
        return current

    def prepare(self, lane, batch, kind=None, requeued=False, item_causes=None):
        kind = kind if lane == 'analysis' else ''
        ns = self.namespaces[lane, kind]
        questions = []
        with self.lock:
            # All questions for a newly observed seed get the same reason.
            old_seeds = set(self.seeds)
            for item in batch:
                inputs = (item.left, item.right) if lane in ('events', 'topics') else (item,)
                ends = [fingerprint(row) for row in inputs]
                if lane == 'events':
                    ends.sort()
                key = digest([lane, ns, kind, ends])
                known = self.answers.get(key)
                causes = [(item_causes or {}).get(fp, self.causes.get(fp, 'other')) for fp in ends]
                if requeued:
                    reason = 'requeue'
                elif known and self.clock() - known[0] >= TTL:
                    reason = 'cache_expired'
                elif known and known[1] == 'cache_evicted':
                    reason = 'cache_evicted'
                elif 'content_changed' in causes:
                    reason = 'content_changed'
                elif lane == 'topics':
                    reason = 'topic_expand' if ends[0] in old_seeds else 'seed_new'
                elif 'new_item' in causes:
                    reason = 'new_item'
                else:
                    reason = 'other'
                fields = QUESTION_SETS[kind] if lane == 'analysis' else ('answer',)
                for field in fields:
                    questions.append({'key': digest([key, field]), 'reason': reason})
                if lane == 'topics':
                    self._remember(self.seeds, ends[0], True)
        return questions

    def http(self, round_id, lane, questions, retry=False, requeued=False):
        if self.disabled:
            return
        row = dict(time=datetime.fromtimestamp(self.clock(), timezone.utc).isoformat(),
                   round=round_id, lane=lane, count=len(questions), questions=questions,
                   retry=bool(retry), requeue=bool(requeued))
        line = encoded(row) + b'\n'
        try:
            with self.io_lock:
                if self.disabled:
                    return
                self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
                # A separate lock inode survives rotation; no scheduler cv held.
                fd = self._open(self.directory / 'trace.lock')
                with os.fdopen(fd, 'ab') as lockfile:
                    fcntl.flock(lockfile, fcntl.LOCK_EX)
                    active = self.directory / 'model-trace.jsonl'
                    fd = self._open(active)
                    with os.fdopen(fd, 'ab') as stream:
                        if len(line) > self.max_bytes // 2:
                            raise OSError('trace row limit')
                        if os.fstat(stream.fileno()).st_size + len(line) > self.max_bytes // 2:
                            backup = self.directory / 'model-trace.jsonl.1'
                            # Oversized preexisting files must not exceed the cap.
                            if os.fstat(stream.fileno()).st_size > self.max_bytes // 2:
                                stream.truncate(0)
                            os.replace(active, backup)
                            fd = self._open(active)
                            with os.fdopen(fd, 'ab') as fresh:
                                fresh.write(line)
                        else:
                            stream.write(line)
        except OSError:
            with self.io_lock:
                if not self.disabled:
                    self.disabled = True
                    self.log('model trace: unavailable; tracing disabled')

    @staticmethod
    def _open(path):
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise OSError('not a regular file')
            os.fchmod(fd, 0o600)
            return fd
        except BaseException:
            os.close(fd)
            raise
