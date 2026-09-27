"""Operation-count guards: normal full-cache insertion must not scan the cache."""
from collections import OrderedDict
from tempfile import TemporaryDirectory
import unittest
from back import answer_cache as ac


class NoScan(OrderedDict):
    def items(self):
        raise AssertionError('whole cache scan during put')
    def values(self):
        raise AssertionError('whole cache scan during put')
    def __iter__(self):
        raise AssertionError('whole cache scan during put')


class CacheEvictionTests(unittest.TestCase):
    def setUp(self):
        tmp = TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.directory = tmp.name
        self.now = 1000000
        self.limits = {lane: 3 for lane in ac.LIMITS}
        self.cache = ac.AnswerCache(tmp.name, clock=lambda: self.now, start_writer=False, limits=self.limits)
        self.ns = {lane: ac.namespace(lane, 'world' if lane == 'analysis' else '') for lane in ac.LIMITS}

    def put(self, lane, n):
        ends = [ac.digest(['news', n])]
        if lane in ('events', 'topics'):
            ends.append(ac.digest(['news', n+1]))
        value = {'classify': 'world', 'analysis': {'kind': 'world', 'trend': 'other', 'region': 'other'},
                 'events': False, 'topics': False, 'tone': 'neutral'}[lane]
        self.cache.put(lane, self.ns[lane], 'world' if lane == 'analysis' else '', ends, value)
        return self.cache._key([lane, self.ns[lane], 'world' if lane == 'analysis' else '',
                                sorted(ends) if lane == 'events' else ends])

    def test_every_lane_full_normal_put_never_scans_records_and_evicts_only_own_oldest(self):
        keys = {lane: [self.put(lane, i) for i in range(3)] for lane in ac.LIMITS}
        self.cache.records = NoScan(self.cache.records)
        class NoLaneScan(OrderedDict):
            def items(self):
                raise AssertionError('normal put must not scan even its own lane')
        self.cache.lane_fifo = {lane: NoLaneScan(rows) for lane, rows in self.cache.lane_fifo.items()}
        for lane in ac.LIMITS:
            new = self.put(lane, 10)
            self.assertNotIn(keys[lane][0], self.cache.records)
            self.assertIn(new, self.cache.records)
            self.assertTrue(all(key in self.cache.records for key in keys[lane][1:]))
            self.assertEqual(self.cache.counts[lane], 3)

    def test_unusable_fifo_head_is_evicted_without_lane_scan(self):
        class NoLaneScan(OrderedDict):
            def items(self):
                raise AssertionError('unusable head must not scan lane')
        for rollback in (False, True):
            with self.subTest(rollback=rollback):
                self.setUp()
                keys = []
                for i in range(3):
                    keys.append(self.put('topics', i))
                    self.now += 10
                self.now += -100 if rollback else ac.TTL
                self.cache.lane_fifo['topics'] = NoLaneScan(self.cache.lane_fifo['topics'])
                for i, oldest in enumerate(keys):
                    fresh = self.put('topics', 10 + i)
                    self.assertNotIn(oldest, self.cache.records)
                    self.assertIn(fresh, self.cache.records)
                    self.assertEqual(self.cache.counts['topics'], 3)
                # Removed timestamps leave conservative bounds: once the head
                # is usable, one lane-local scan may tighten them, never evict
                # a newer usable answer before the FIFO head.
                self.cache.lane_fifo['topics'] = OrderedDict(self.cache.lane_fifo['topics'])
                oldest = next(iter(self.cache.lane_fifo['topics']))
                self.put('topics', 20)
                self.assertNotIn(oldest, self.cache.records)

    def test_rollback_scan_is_lane_local_and_future_tail_loses_before_usable_head(self):
        head = self.put('tone', 0)
        self.now += 60
        tail = self.put('tone', 1)
        self.now -= 60
        self.put('tone', 2)
        for i in range(3): self.put('topics', i)
        self.cache.records = NoScan(self.cache.records)
        new = self.put('tone', 3)
        self.assertNotIn(tail, self.cache.records)
        self.assertIn(head, self.cache.records)
        self.assertIn(new, self.cache.records)

    def test_refresh_fifo_indexes_restart_and_expiration(self):
        a = self.put('classify', 0)
        self.now += ac.TTL
        b = self.put('classify', 1)
        self.put('classify', 0)  # Refresh old a: b is now oldest.
        c = self.put('classify', 2)
        self.cache.records = NoScan(self.cache.records)
        self.put('classify', 3)
        self.assertNotIn(b, self.cache.records)
        self.assertIn(a, self.cache.records)
        self.assertIn(c, self.cache.records)
        self.cache.records = OrderedDict(OrderedDict.items(self.cache.records))
        self.assertTrue(self.cache.flush())
        self.cache = ac.AnswerCache(self.directory, clock=lambda: self.now, start_writer=False, limits=self.limits)
        self.cache.records = NoScan(self.cache.records)
        self.now += ac.TTL
        fresh = self.put('classify', 4)
        self.assertIn(fresh, self.cache.records)
        self.assertNotIn(a, self.cache.records)

    def test_full_capacity_indexes_stay_bounded_during_refresh_and_eviction(self):
        for i in range(120):
            if i % 20 == 0: self.now += ac.TTL
            for lane in ac.LIMITS: self.put(lane, i % 11)
        for lane in ac.LIMITS:
            expected = [key for key, row in self.cache.records.items() if row[0] == lane]
            self.assertEqual(list(self.cache.lane_fifo[lane]), expected)
            self.assertEqual(len(expected), self.limits[lane])
        self.assertEqual(sum(map(len, self.cache.lane_fifo.values())), len(self.cache.records))
