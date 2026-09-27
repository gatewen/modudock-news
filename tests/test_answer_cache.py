"""Disk answers use synthetic news only; every test has an isolated directory."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import fcntl
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from back import answer_cache as ac
from back.scheduler import Scheduler, ClassifyResult, EventResult, ModelRound
from back.feedparse import dedup_key
from tests.test_scheduler import Sink, eventually
from tests.test_model_chaos import Scenario


class AnswerCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1000000.0
        self.logs = []
        self.cache = self.new()
        self.ns = ac.namespace('classify')
        self.a = ('https://example.test/a', '標題甲', '摘要甲')
        self.b = ('https://example.test/b', '標題乙', '摘要乙')

    def new(self, **options):
        return ac.AnswerCache(self.temp.name, clock=lambda: self.now, log=self.logs.append,
                              start_writer=False, **options)

    def put(self, item=None, value='tech'):
        self.cache.put('classify', self.ns, '', [ac.fingerprint(item or self.a)], value)

    def test_roundtrip_all_lanes_false_and_private_file(self):
        self.put()
        examples = [('analysis', 'world', {'kind': 'world', 'trend': 'other', 'region': 'other'}),
                    ('events', '', False), ('topics', '', False), ('tone', '', 'neutral')]
        for lane, kind, value in examples:
            ends = [ac.fingerprint(self.a)] + ([ac.fingerprint(self.b)] if lane in ('events', 'topics') else [])
            self.cache.put(lane, ac.namespace(lane, kind), kind, ends, value)
        self.assertTrue(self.cache.flush())
        self.assertEqual(len(self.new().snapshot()), 5)
        raw = self.cache.path.read_text()
        for forbidden in ('https:', 'example.test', '標題', '摘要', 'TYPESAFE', 'Bearer'):
            self.assertNotIn(forbidden, raw)
        self.assertEqual(self.cache.path.stat().st_mode & 0o777, 0o600)

    def test_contract_ttl_is_72_hours_not_an_implementation_relative_clock(self):
        self.put()
        self.cache.flush()
        self.now += 72 * 3600 - 1
        self.assertEqual(len(self.new().snapshot()), 1)
        self.now += 1
        self.assertEqual(self.cache.snapshot(), [])
        self.assertEqual(self.new().snapshot(), [])

    def test_ttl_absolute_hits_never_extend_and_future_is_miss(self):
        self.put()
        stamp = self.cache.snapshot()[0][4]
        self.now += ac.TTL - 1
        self.put()
        self.assertEqual(self.cache.snapshot()[0][4], stamp)
        self.cache.flush()
        self.now += 1
        self.assertEqual(self.new().snapshot(), [])
        self.now = stamp - 1
        self.assertEqual(self.new().snapshot(), [])

    def test_corrupt_truncated_oversize_schema_and_invalid_values_are_misses(self):
        for raw in ('{', '{"schema":999,"records":[]}', 'x' * 1001,
                    json.dumps({'schema': ac.SCHEMA, 'records': [['bad']]})):
            with self.subTest(raw=raw[:20]):
                self.cache.path.write_text(raw)
                self.assertEqual(self.new(max_bytes=1000).snapshot(), [])
        for value in ({'raw': self.a[0]}, True, 'invented'):
            self.put(value=value)
        self.assertEqual(self.cache.snapshot(), [])
        self.cache.put('events', ac.namespace('events'), '', ['x', 'y'], False)
        self.assertEqual(self.cache.snapshot(), [])

    def test_model_criteria_question_threshold_and_kind_change_namespace(self):
        original = ac.namespace('classify')
        with patch.object(ac.classify, 'MODEL', 'next'):
            self.assertNotEqual(original, ac.namespace('classify'))
        with patch.dict(ac.classify.CRITERIA, tech='different criteria'):
            self.assertNotEqual(original, ac.namespace('classify'))
        with patch.object(ac.classify, 'THRESHOLD', .36):
            self.assertNotEqual(original, ac.namespace('classify'))
        self.assertNotEqual(ac.namespace('analysis', 'finance'), ac.namespace('analysis', 'world'))
        with patch.object(ac.classify.Classifier, '_questions', lambda self, size, context: {'new': 'question'}):
            self.assertNotEqual(original, ac.namespace('classify'))

    def test_pairs_unordered_topics_directed_and_content_boundaries(self):
        a, b = map(ac.fingerprint, (self.a, self.b))
        for lane in ('events', 'topics'):
            for ends in ([a, b], [b, a]):
                self.cache.put(lane, ac.namespace(lane), '', ends, False)
        self.assertEqual([r[0] for r in self.cache.snapshot()].count('events'), 1)
        self.assertEqual([r[0] for r in self.cache.snapshot()].count('topics'), 2)
        self.assertNotEqual(ac.fingerprint(('key', 'ab', 'c')), ac.fingerprint(('key', 'a', 'bc')))
        self.assertNotEqual(ac.fingerprint(self.a), ac.fingerprint((self.a[0], '改稿', self.a[2])))

    def test_fifo_lane_limits_and_total_file_limit(self):
        self.cache = self.new(limits=dict(ac.LIMITS, classify=3), max_bytes=1600)
        for n in range(12):
            self.now += 1
            self.put((str(n), '', ''))
        self.assertEqual(len(self.cache.snapshot()), 3)
        self.assertNotIn(ac.fingerprint(('0', '', '')), str(self.cache.snapshot()))
        self.assertTrue(self.cache.flush())
        self.assertLessEqual(self.cache.path.stat().st_size, 1600)
        self.assertLessEqual(len(self.new(max_bytes=1600).snapshot()), 3)

    def test_concurrent_producers_and_two_writers_merge(self):
        other = self.new()
        def put(n):
            store = self.cache if n % 2 else other
            store.put('classify', self.ns, '', [ac.fingerprint((str(n), '', ''))], 'tech')
        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(put, range(100)))
            list(pool.map(lambda store: store.flush(), [self.cache, other]))
        # A busy peer skips without waiting; the next scheduled pass merges.
        self.cache.flush()
        other.flush()
        self.assertEqual(len(self.new().snapshot()), 100)

    def test_nonblocking_process_lock_keeps_dirty_for_retry(self):
        self.put()
        with open(Path(self.temp.name) / 'writer.lock', 'wb') as peer:
            fcntl.flock(peer, fcntl.LOCK_EX | fcntl.LOCK_NB)
            started = time.monotonic()
            self.assertFalse(self.cache.flush())
            self.assertLess(time.monotonic() - started, .1)
            self.assertNotEqual(self.cache.saved, self.cache.revision)
        self.assertTrue(self.cache.flush())

    def test_atomic_replace_failure_keeps_old_file_memory_and_logs_once(self):
        self.put()
        self.cache.flush()
        old = self.cache.path.read_bytes()
        self.put(self.b)
        with patch.object(ac.os, 'replace', side_effect=OSError('secret URL')):
            self.assertFalse(self.cache.flush())
        self.assertEqual(self.cache.path.read_bytes(), old)
        self.assertEqual(len(self.cache.snapshot()), 2)
        self.assertFalse(self.cache.flush())
        self.assertEqual(self.logs, ['answer cache: unavailable; using memory'])
        self.assertEqual(list(Path(self.temp.name).glob('*.tmp')), [])

    def test_unwritable_directory_falls_back_to_memory(self):
        path = Path(self.temp.name) / 'file'
        path.write_text('not a directory')
        cache = ac.AnswerCache(path, log=self.logs.append, start_writer=False)
        cache.put('classify', self.ns, '', [ac.fingerprint(self.a)], 'tech')
        self.assertFalse(cache.flush())
        self.assertEqual(len(cache.snapshot()), 1)
        self.assertEqual(self.logs, ['answer cache: read failed; using available memory',
                                    'answer cache: unavailable; using memory'])

    def test_background_debounce_and_daemon_no_stop_join(self):
        cache = ac.AnswerCache(self.temp.name, interval=.02)
        cache.put('classify', self.ns, '', [ac.fingerprint(self.a)], 'tech')
        eventually(lambda: cache.saved == cache.revision)
        self.assertTrue(cache.thread.daemon)
        self.assertEqual(len(ac.AnswerCache(self.temp.name, start_writer=False).snapshot()), 1)

    def test_sticky_hints_bounded_expiring_and_versioned(self):
        ns = ac.namespace('topics')
        hints = [ac.fingerprint((str(n), '', '')) for n in range(8)]
        self.cache.remember_seeds(ns, hints)
        self.cache.flush()
        self.assertEqual(self.new().seeds(ns), hints[:5])
        self.assertEqual(self.new().seeds('f' * 64), [])
        self.now += ac.TTL
        self.assertEqual(self.new().seeds(ns), [])

    def scheduler(self):
        return Scheduler([{'name': '甲', 'url': 'unused'}], None, Sink(), 1,
                         log=self.logs.append, answer_cache=self.cache)

    def test_restore_changed_text_invalidates_single_and_related_pairs(self):
        scheduler = self.scheduler()
        bridge = scheduler.answer_cache
        self.put()
        a, b = map(ac.fingerprint, (self.a, self.b))
        for lane in ('events', 'topics'):
            self.cache.put(lane, ac.namespace(lane), '', [a, b], False)
        items = [dict(link=i[0], title=i[1], summary=i[2]) for i in (self.a, self.b)]
        bridge.restore(scheduler, items)
        self.assertEqual(scheduler.classify_cache[self.a[0]], 'tech')
        self.assertEqual(len(scheduler.event_cache), 1)
        self.assertEqual(len(scheduler.topic_cache), 1)
        items[0]['summary'] = 'edited'
        bridge.restore(scheduler, items)
        self.assertFalse(scheduler.classify_cache)
        self.assertFalse(scheduler.event_cache)
        self.assertFalse(scheduler.topic_cache)

    def test_version_mismatch_not_restored_and_analysis_kind_matches_category(self):
        scheduler = self.scheduler()
        fp = ac.fingerprint(self.a)
        self.cache.put('classify', '0' * 64, '', [fp], 'tech')
        self.cache.put('analysis', ac.namespace('analysis', 'world'), 'world', [fp],
                       {'kind': 'world', 'trend': 'other', 'region': 'other'})
        items = [dict(link=self.a[0], title=self.a[1], summary=self.a[2])]
        scheduler.answer_cache.restore(scheduler, items)
        self.assertFalse(scheduler.classify_cache)
        self.assertFalse(scheduler.analysis_cache)
        self.put(value='world')
        scheduler.answer_cache.restore(scheduler, items)
        self.assertEqual(scheduler.analysis_cache[self.a[0]]['kind'], 'world')

    def test_late_old_result_stored_under_old_fingerprint_not_new_story(self):
        scheduler = self.scheduler()
        bridge = scheduler.answer_cache
        bridge.restore(scheduler, [dict(link=self.a[0], title='edited', summary=self.a[2])])
        candidate = ClassifyResult({self.a[0]: 'tech'}, (self.a[0],), 1)
        candidate.cache_provenance = ('classify', '', {self.a[0]: (self.a,)}, 'categories')
        with scheduler.cv:
            scheduler._accept_candidate(candidate)
        self.assertFalse(scheduler.classify_cache)
        self.assertEqual(self.cache.snapshot()[0][3], [ac.fingerprint(self.a)])

    def test_empty_failure_never_saved(self):
        scheduler = self.scheduler()
        candidate = ClassifyResult({}, (self.a[0],), 1)
        candidate.cache_provenance = ('classify', '', {self.a[0]: (self.a,)}, 'categories')
        with scheduler.cv:
            scheduler._accept_candidate(candidate)
        self.assertEqual(self.cache.snapshot(), [])

    def test_loaded_seed_must_still_have_three_outlets(self):
        scheduler = self.scheduler()
        bridge = scheduler.answer_cache
        self.cache.remember_seeds(ac.namespace('topics'), [ac.fingerprint(self.a)])
        items = [dict(link=self.a[0], title=self.a[1], summary=self.a[2], source='甲')]
        bridge.restore(scheduler, items)
        self.assertEqual(scheduler.last_topic_seeds, (self.a[0],))
        bridge.validate_seeds(scheduler, items, {self.a[0]: {'event': 'a' * 12}})
        self.assertEqual(scheduler.last_topic_seeds, ())

    def test_ttl_also_clears_live_memory_on_next_fetch(self):
        scheduler = self.scheduler()
        self.put()
        items = [dict(link=self.a[0], title=self.a[1], summary=self.a[2])]
        scheduler.answer_cache.restore(scheduler, items)
        self.assertTrue(scheduler.classify_cache)
        self.now += ac.TTL
        scheduler.answer_cache.restore(scheduler, items)
        self.assertFalse(scheduler.classify_cache)

    def test_stop_does_not_wait_for_blocked_writer(self):
        import threading
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        cache = ac.AnswerCache(self.temp.name, interval=100)
        scheduler = Scheduler([{'name': '甲', 'url': 'unused'}], None, Sink(), 1,
                              log=self.logs.append, answer_cache=cache)
        original = ac.os.fsync
        def blocked(fd):
            entered.set()
            release.wait(2)
            original(fd)
        with patch.object(ac.os, 'fsync', blocked):
            cache.put('classify', self.ns, '', [ac.fingerprint(self.a)], 'tech')
            cache.request_flush()
            self.assertTrue(entered.wait(1))
            started = time.monotonic()
            scheduler.stop()
            self.assertLess(time.monotonic() - started, .1)
            release.set()
            eventually(lambda: cache.saved == cache.revision)

    def test_all_lane_limits_and_invalid_analysis_extra_fields(self):
        limits = dict.fromkeys(ac.LIMITS, 2)
        store = self.new(limits=limits)
        for lane in limits:
            kind = 'world' if lane == 'analysis' else ''
            value = {'kind': 'world', 'trend': 'other', 'region': 'other'} if kind else (
                False if lane in ('events', 'topics') else 'neutral' if lane == 'tone' else 'tech')
            for n in range(4):
                self.now += 1
                ends = [ac.fingerprint((str(n), '', ''))]
                if lane in ('events', 'topics'):
                    ends.append(ac.fingerprint(self.b))
                store.put(lane, ac.namespace(lane, kind), kind, ends, value)
        self.assertEqual(len(store.snapshot()), 10)
        for lane in limits:
            self.assertEqual(sum(row[0] == lane for row in store.snapshot()), 2)
        store.put('analysis', ac.namespace('analysis', 'world'), 'world', [ac.fingerprint(self.a)],
                  {'kind': 'world', 'trend': 'other', 'region': 'other', 'url': self.a[0]})
        self.assertEqual(len(store.snapshot()), 10)

    def test_restart_pending_events_preserves_restored_seeds_until_validation(self):
        def run(store, extra=()):
            scenario = Scenario(47002, 0)
            scenario.clean = True
            scenario.current = list(scenario.snapshots[3]) + list(extra)
            scheduler = scenario.scheduler
            bridge = scheduler.answer_cache = ac.CacheBridge(store)
            seen = {}
            restore, validate = bridge.restore, bridge.validate_seeds
            def restoring(sc, items):
                restore(sc, items)
                seen.setdefault('restored', sc.last_topic_seeds)
            def validating(sc, items, groups):
                if bridge.validate_loaded_seeds:
                    seen.setdefault('validating', sc.last_topic_seeds)
                validate(sc, items, groups)
            bridge.restore, bridge.validate_seeds = restoring, validating
            try:
                scheduler.start()
                eventually(lambda: scenario.settled() and scheduler.last_list['body']['model']['state'] == 'done', timeout=5)
                packets = list(scheduler.outbox.packets.queue)
                first = next(p['body'] for p in packets if p.get('body', {}).get('op') == 'list')
                return seen, scheduler.last_topic_seeds, first
            finally:
                scheduler.stop()
                for worker in scheduler.workers + scheduler.classify_workers + [scheduler.coordinator]:
                    worker.join(2)
                    self.assertFalse(worker.is_alive())
        _, seeds, _ = run(self.cache)
        self.assertTrue(seeds)
        self.assertTrue(self.cache.flush())
        seen, _, first = run(self.new(), [(99, '跨海和平峰會合作協議進展今日續談', '丙')])
        self.assertGreater(first['events']['pending'], 0)
        self.assertEqual(seen['restored'], seeds)
        self.assertEqual(seen['validating'], seeds)

    def test_clock_rollback_misses_but_flush_preserves_recoverable_answers(self):
        for n in range(100):
            self.put((str(n), '', ''))
        self.cache.flush()
        self.now -= 60
        # Exercise both the existing process and a restarted one.
        restarted = self.new()
        self.assertEqual(restarted.snapshot(), [])
        self.assertEqual(self.cache.snapshot(), [])
        self.put(('new', '', ''))
        self.cache.flush()
        restarted.flush()
        self.assertEqual(len(json.loads(self.cache.path.read_text())['records']), 101)
        self.now += 120
        self.assertEqual(len(self.new().snapshot()), 101)

    def test_clock_future_bound_and_seed_hint_recovery(self):
        self.put()
        ns = ac.namespace('topics')
        self.cache.remember_seeds(ns, [ac.fingerprint(self.a)])
        self.cache.flush()
        stamp = self.now
        self.now -= 86400
        restarted = self.new()
        self.assertEqual(restarted.snapshot(), [])
        self.assertEqual(restarted.seeds(ns), [])
        restarted.flush()
        self.now = stamp
        self.assertEqual(len(self.new().snapshot()), 1)
        self.assertEqual(self.new().seeds(ns), [ac.fingerprint(self.a)])
        self.now -= 86401
        self.new().flush()
        self.now = stamp
        self.assertEqual(self.new().snapshot(), [])
        self.assertEqual(self.new().seeds(ns), [])

    def test_old_writer_temp_cleanup_requires_lock_age_and_exact_regular_name(self):
        root = Path(self.temp.name)
        old = root / 'answers-abcdefgh.tmp'
        fresh = root / 'answers-12345678.tmp'
        foreign = root / 'answers-not-ours.tmp'
        target = root / 'other-data'
        folder = root / 'answers-abcdefgh.tmp.dir'
        link = root / 'answers-87654321.tmp'
        for path in (old, fresh, foreign, target):
            path.write_text('keep unless abandoned writer temp')
            os.utime(path, (self.now - 601, self.now - 601))
        os.utime(fresh, (self.now - 599, self.now - 599))
        folder.mkdir()
        link.symlink_to(target)
        with (root / 'writer.lock').open('wb') as peer:
            fcntl.flock(peer, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertFalse(self.cache.flush())
            self.assertTrue(old.exists())
        self.assertTrue(self.cache.flush())
        self.assertFalse(old.exists())
        for path in (fresh, foreign, target, folder, link):
            self.assertTrue(path.exists(), path.name)

    def test_expired_key_refreshed_moves_to_fifo_tail(self):
        self.cache = self.new(limits=dict(ac.LIMITS, classify=3))
        for key in 'abc':
            self.put((key, '', ''))
            self.now += 1
        self.now += ac.TTL
        self.put(('a', '', ''))
        self.put(('d', '', ''))
        fingerprints = [row[3][0] for row in self.cache.snapshot()]
        self.assertIn(ac.fingerprint(('a', '', '')), fingerprints)
        self.assertIn(ac.fingerprint(('d', '', '')), fingerprints)
        self.assertEqual(len(self.cache.records), 3)

    def test_corrupt_read_repaired_does_not_consume_unwritable_warning(self):
        self.put()
        self.cache.path.write_text('{broken')
        self.assertTrue(self.cache.flush())
        self.assertFalse(self.cache.disabled)
        self.assertEqual(self.logs, ['answer cache: corrupt file ignored; will rebuild'])
        self.assertEqual(len(self.new().snapshot()), 1)
        self.cache.path.write_text('{broken again')
        self.assertTrue(self.cache.flush())
        self.assertEqual(len(self.logs), 1)
        with patch.object(ac.os, 'replace', side_effect=OSError('secret URL')):
            self.put(self.b)
            self.assertFalse(self.cache.flush())
        self.assertTrue(self.cache.disabled)
        self.assertEqual(self.logs, ['answer cache: corrupt file ignored; will rebuild',
                                    'answer cache: unavailable; using memory'])

    def test_rollback_current_seed_beats_future_disk_and_future_peer(self):
        ns = ac.namespace('topics')
        self.cache.remember_seeds(ns, ['1' * 64])
        self.assertTrue(self.cache.flush())
        self.now -= 60
        current, stale_peer = self.new(), self.new()
        current.remember_seeds(ns, ['2' * 64])
        self.assertTrue(current.flush())
        self.assertEqual(self.new().seeds(ns), ['2' * 64])
        # A peer retaining the future hint must adopt the usable disk hint.
        self.assertTrue(stale_peer.flush())
        self.assertEqual(stale_peer.seeds(ns), ['2' * 64])
        self.now += 120
        self.assertEqual(self.new().seeds(ns), ['2' * 64])

    def test_rollback_new_answer_beats_future_disk_and_future_peer(self):
        self.put(value='tech')
        self.assertTrue(self.cache.flush())
        self.now -= 60
        current, stale_peer = self.new(), self.new()
        self.assertEqual(current.snapshot(), [])
        current.put('classify', self.ns, '', [ac.fingerprint(self.a)], 'world')
        self.assertTrue(current.flush())
        self.assertEqual([r[5] for r in self.new().snapshot()], ['world'])
        # Opposite merge direction: future memory cannot overwrite usable disk.
        self.assertTrue(stale_peer.flush())
        self.now += 120
        self.assertEqual([r[5] for r in self.new().snapshot()], ['world'])

    def test_future_rows_lose_capacity_priority_by_count_and_bytes(self):
        current = ['classify', self.ns, '', [ac.fingerprint(self.a)], self.now, 'world']
        future = ['classify', self.ns, '', [ac.fingerprint(self.b)], self.now + 60, 'tech']
        records = {ac.AnswerCache._key(r): r for r in (current, future)}
        for byte_limit in (False, True):
            with self.subTest(byte_limit=byte_limit):
                options = ({'max_bytes': len(ac.encoded({'schema': ac.SCHEMA, 'records': [], 'seeds': None}))
                            + 512 + max(len(ac.encoded(r)) + 1 for r in records.values())}
                           if byte_limit else {'limits': dict(ac.LIMITS, classify=1)})
                cache = self.new(**options)
                kept = cache._prune(records)
                self.assertEqual(list(kept.values()), [current])
        # With spare capacity preserve the future row, still unavailable until recovery.
        kept = self.cache._prune(records)
        self.assertEqual(list(kept.values()), [future, current])

    def test_future_rows_evicted_before_usable_rows_in_memory(self):
        self.cache = self.new(limits=dict(ac.LIMITS, classify=2))
        self.put(self.a)
        self.now += 120
        self.put(self.b)
        self.now -= 60  # a is usable, b is in the future but later in FIFO.
        self.put(('c', '', ''))
        self.assertEqual({r[3][0] for r in self.cache.records.values()},
                         {ac.fingerprint(self.a), ac.fingerprint(('c', '', ''))})

    def test_expired_local_row_cannot_displace_recoverable_future_disk_row(self):
        self.put(value='tech')
        stale = self.cache
        self.now += ac.TTL + 60
        peer = self.new()
        peer.put('classify', self.ns, '', [ac.fingerprint(self.a)], 'world')
        self.assertTrue(peer.flush())
        self.now -= 30
        self.assertTrue(stale.flush())
        self.now += 60
        self.assertEqual([r[5] for r in self.new().snapshot()], ['world'])

    def test_read_oserror_warning_does_not_consume_unwritable_warning(self):
        self.put()
        self.assertTrue(self.cache.flush())
        # Mock the read boundary rather than chmod: deterministic even as root.
        with patch.object(Path, 'open', side_effect=PermissionError('SECRET https://private.invalid')):
            self.assertTrue(self.cache.flush())
            self.assertTrue(self.cache.flush())
        self.assertFalse(self.cache.disabled)
        self.assertEqual(self.logs, ['answer cache: read failed; using available memory'])
        self.assertEqual(len(self.new().snapshot()), 1)
        with patch.object(ac.os, 'replace', side_effect=OSError('SECRET URL')):
            self.assertFalse(self.cache.flush())
            self.assertFalse(self.cache.flush())
        self.assertTrue(self.cache.disabled)
        self.assertEqual(self.logs, ['answer cache: read failed; using available memory',
                                    'answer cache: unavailable; using memory'])

    def test_two_cold_schedulers_same_snapshot_zero_http_and_identical_topics(self):
        def run(store):
            scenario = Scenario(47001 + 1, 0)  # clean classify path, deterministic answers
            scenario.clean = True
            scenario.current = scenario.snapshots[3]
            scheduler = scenario.scheduler
            scheduler.answer_cache = ac.CacheBridge(store)
            try:
                scheduler.start()
                eventually(lambda: scenario.settled() and scheduler.last_list['body']['model']['state'] == 'done', timeout=5)
                return deepcopy(scheduler.last_list['body']), dict(scenario.calls), scenario.logs
            finally:
                scheduler.stop()
                for worker in scheduler.workers + scheduler.classify_workers + [scheduler.coordinator]:
                    worker.join(2)
                    self.assertFalse(worker.is_alive())
        first, calls, _ = run(self.cache)
        self.assertTrue(all(calls.get(lane, 0) for lane in ac.LIMITS), calls)
        self.assertTrue(self.cache.flush())
        second, calls, logs = run(self.new())
        self.assertEqual(calls, {})
        stats = [line for line in logs if line.startswith('model round=')]
        self.assertEqual(len(stats), 1)
        self.assertIn('requests=0 failed=0 elapsed=0.0s', stats[0])
        self.assertIn('http=0 retries=0 total_http=0', stats[0])
        self.assertRegex(stats[0], r' cached=[1-9][0-9]* ')
        for field in ('items', 'topics', 'events', 'classify', 'analysis'):
            self.assertEqual(first[field], second[field], field)


if __name__ == '__main__':
    unittest.main()
