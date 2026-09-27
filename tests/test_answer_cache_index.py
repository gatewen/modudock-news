"""Indexed projection must equal the old full-snapshot restore, including FIFO."""
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch
import random
import unittest

from back import answer_cache as ac
from back.scheduler import Scheduler


class AnswerCacheIndexTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.now = 1000000
        self.store = ac.AnswerCache(self.tmp.name, clock=lambda: self.now, start_writer=False)
        self.items = [dict(link=f'https://test.invalid/{i}', title=f'title{i}', summary=f'summary{i}') for i in range(16)]
        self.fps = [ac.fingerprint((i['link'], i['title'], i['summary'])) for i in self.items]
        self.ns = {lane: ac.namespace(lane, 'world' if lane == 'analysis' else '') for lane in ac.LIMITS}

    def put(self, lane, ends, value):
        self.store.put(lane, self.ns[lane], 'world' if lane == 'analysis' else '', ends, value)

    def assert_indexes(self):
        self.assertEqual({key for bucket in self.store.by_fingerprint.values() for key in bucket}, set(self.store.records))
        self.assertEqual(set(self.store.by_fingerprint), {row[3][0] for row in self.store.records.values()})
        for fp, keys in self.store.by_fingerprint.items():
            self.assertEqual(set(keys), {key for key, row in self.store.records.items() if fp == row[3][0]})

    def test_projection_all_endpoints_fifo_false_and_detached_values(self):
        a, b, c = self.fps[:3]
        self.put('classify', [a], 'world')
        self.put('events', [a, b], False)
        self.put('topics', [b, a], False)
        self.put('analysis', [a], dict(kind='world', trend='other', region='other'))
        self.put('tone', [c], 'positive')
        expected = [row for row in self.store.snapshot() if all(fp in {a, b} for fp in row[3])]
        actual = self.store.snapshot([a, b])
        self.assertEqual(actual, expected)
        self.assertEqual([r[0] for r in self.store.snapshot([a])], ['classify', 'analysis'])
        self.assertEqual(self.store.snapshot([]), [])
        self.assertEqual(self.store.snapshot(['f' * 64]), [])
        actual[-1][5]['region'] = 'invalid'
        self.assertEqual(self.store.snapshot([a, b]), expected)
        self.assert_indexes()

    def test_indexed_lookup_never_scans_or_copies_unrelated_records(self):
        for fp in self.fps:
            self.put('classify', [fp], 'world')
        class NoScan(OrderedDict):
            def values(self):
                raise AssertionError('full cache scan')
            def __iter__(self):
                raise AssertionError('full key scan')
        self.store.records = NoScan(self.store.records)
        with patch.object(self.store, '_valid', wraps=self.store._valid) as validate:
            rows = self.store.snapshot(self.fps[:2])
        self.assertEqual(len(rows), 2)
        self.assertEqual(validate.call_count, 2)

    def test_refresh_eviction_restart_and_duplicate_endpoint_do_not_leak_index(self):
        self.store.limits = dict(ac.LIMITS, classify=2, events=1)
        for fp in self.fps[:3]:
            self.put('classify', [fp], 'world')
        self.assertEqual(self.store.snapshot(self.fps[:1]), [])
        self.assert_indexes()
        self.now += ac.TTL
        self.put('classify', [self.fps[1]], 'tech')
        self.put('events', [self.fps[0], self.fps[0]], False)
        self.put('events', self.fps[2:4], True)
        self.assert_indexes()
        self.assertTrue(self.store.flush())
        restart = ac.AnswerCache(self.tmp.name, clock=lambda: self.now, start_writer=False)
        self.assertEqual(restart.snapshot(self.fps), restart.snapshot())
        self.store = restart
        self.assert_indexes()

    def test_ttl_future_recovery_and_expired_replacement_projection_order(self):
        self.put('classify', [self.fps[0]], 'world')
        self.now += 1
        self.put('classify', [self.fps[1]], 'tech')
        self.now -= 2
        self.assertEqual(self.store.snapshot(self.fps), [])
        self.now += 3
        self.assertEqual(self.store.snapshot(self.fps), self.store.snapshot())
        self.now += ac.TTL
        self.put('classify', [self.fps[0]], 'life')
        self.assertEqual(self.store.snapshot(self.fps), self.store.snapshot())
        self.assertEqual([r[5] for r in self.store.snapshot(self.fps)], ['life'])
        self.assert_indexes()

    def test_restore_differential_against_full_scan_for_100_scopes(self):
        for n, fp in enumerate(self.fps):
            self.put('classify', [fp], 'world' if n % 2 else 'finance')
            self.put('analysis', [fp], dict(kind='world', trend='other', region='other'))
            self.put('tone', [fp], 'neutral')
            self.put('topics', [fp, self.fps[(n+1) % len(self.fps)]], bool(n % 2))
            self.put('events', [fp, self.fps[(n+2) % len(self.fps)]], bool(n % 2))
        # A mismatched namespace must still be filtered by CacheBridge.
        self.store.put('tone', 'f' * 64, '', [self.fps[0]], 'negative')
        rng = random.Random(2214)
        for _ in range(100):
            selected = rng.sample(self.items, rng.randrange(len(self.items)+1))
            for item in selected:
                if rng.random() < .2:
                    item = dict(item, summary='edited')
                    selected = [item if i['link'] == item['link'] else i for i in selected]
            old = Scheduler([{'name': 'A'}], None, None, 1)
            new = Scheduler([{'name': 'A'}], None, None, 1)
            # Independent oracle: original full snapshot, no indexed filtering.
            full = SimpleNamespace(snapshot=lambda *_: self.store.snapshot(), seeds=self.store.seeds)
            ac.CacheBridge(full).restore(old, selected)
            ac.CacheBridge(self.store).restore(new, selected)
            self.assertEqual({k: list(v.items()) for k,v in ac.CacheBridge.caches(old).items()},
                             {k: list(v.items()) for k,v in ac.CacheBridge.caches(new).items()})

    def test_concurrent_writes_projection_and_fifo_eviction_stay_bounded(self):
        self.store.limits = dict(ac.LIMITS, classify=5, events=5)
        def write(n):
            fp = self.fps[n % len(self.fps)]
            self.put('classify', [fp], 'world')
            self.put('events', [fp, self.fps[(n+1) % len(self.fps)]], False)
            self.store.snapshot(self.fps[:8])
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(write, range(150)))
        self.assert_indexes()
        self.assertLessEqual(len(self.store.records), 10)
        self.assertLessEqual(sum(map(len, self.store.by_fingerprint.values())), 10)
