import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from concurrent.futures import ThreadPoolExecutor
import unittest
from unittest.mock import patch

from back.answer_cache import AnswerCache, fingerprint, encoded, namespace, TTL
from back.model_trace import ModelTrace, optional_trace
from back.topics import TopicPair
from back.events import Pair


class ModelTraceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)
        self.now = [1000000]
        self.logs = []
        self.trace = ModelTrace(self.path, clock=lambda: self.now[0], log=self.logs.append)
        self.a = ('https://secret.invalid/a', 'PRIVATE-TITLE', 'PRIVATE-SUMMARY')
        self.b = ('https://secret.invalid/b', 'SECOND-TITLE', '')

    def observe(self, *items):
        return self.trace.items([dict(link=i[0], title=i[1], summary=i[2]) for i in items])

    def reason(self, lane, batch, **kwargs):
        return [q['reason'] for q in self.trace.prepare(lane, batch, **kwargs)]

    def test_opt_in_checked_once_no_files_or_hashing_without_marker(self):
        with patch('back.model_trace.ModelTrace', side_effect=AssertionError('must stay off')):
            self.assertIsNone(optional_trace(self.path))
        self.assertEqual(list(self.path.iterdir()), [])
        (self.path / 'trace.enable').touch()
        trace = optional_trace(self.path)
        (self.path / 'trace.enable').unlink()
        self.assertIsInstance(trace, ModelTrace)  # Changes apply on next module load.

    def test_new_changed_old_and_overlapping_round_provenance(self):
        baseline = self.observe(self.b)
        self.assertEqual(self.reason('classify', [self.b], item_causes=baseline), ['new_item'])
        early = self.observe(self.a)
        self.assertEqual(self.reason('classify', [self.a], item_causes=early), ['new_item'])
        later = self.observe(self.a)
        self.assertEqual(self.reason('analysis', [self.a], kind='world', item_causes=later), ['new_item'] * 2)
        changed = (self.a[0], 'UPDATED', self.a[2])
        newest = self.observe(changed)
        self.assertEqual(self.reason('classify', [changed], item_causes=newest), ['content_changed'])
        self.assertEqual(self.reason('classify', [self.a], item_causes=early), ['new_item'])
        self.assertEqual(self.reason('tone', [changed], requeued=True), ['requeue'])

    def test_topic_seed_then_expansion_and_question_counts(self):
        self.observe(self.a, self.b)
        pair = TopicPair(self.a, self.b)
        self.assertEqual(self.reason('topics', [pair, pair]), ['seed_new'] * 2)
        self.assertEqual(self.reason('topics', [pair]), ['topic_expand'])
        for kind, count in [('finance', 3), ('world', 2), ('politics', 1)]:
            questions = self.trace.prepare('analysis', [self.a, self.b], kind)
            self.assertEqual(len(questions), count * 2)
            self.assertEqual(len({q['key'] for q in questions}), count * 2)

    def test_hash_keys_preserve_event_symmetry_topic_direction_and_kind(self):
        a = self.trace.prepare('events', [Pair(self.a, self.b, .5)])[0]['key']
        b = self.trace.prepare('events', [Pair(self.b, self.a, .5)])[0]['key']
        self.assertEqual(a, b)
        a = self.trace.prepare('topics', [TopicPair(self.a, self.b)])[0]['key']
        b = self.trace.prepare('topics', [TopicPair(self.b, self.a)])[0]['key']
        self.assertNotEqual(a, b)
        self.assertNotEqual(self.trace.prepare('analysis', [self.a], 'world')[0]['key'],
                            self.trace.prepare('analysis', [self.a], 'finance')[0]['key'])

    def test_expiry_and_eviction_are_observed_not_guessed(self):
        store = AnswerCache(self.path, clock=lambda: self.now[0], trace=self.trace,
                            limits={'classify': 1}, start_writer=False)
        ns = namespace('classify')
        store.put('classify', ns, '', [fingerprint(self.a)], 'tech')
        self.now[0] += 1
        store.put('classify', ns, '', [fingerprint(self.b)], 'world')
        self.assertEqual(self.reason('classify', [self.a]), ['cache_evicted'])
        self.now[0] += TTL
        self.assertEqual(self.reason('classify', [self.b]), ['cache_expired'])
        self.assertEqual(self.reason('tone', [self.a]), ['other'])

    def test_restart_expired_disk_record_and_existing_seed(self):
        rows = [['classify', namespace('classify'), '', [fingerprint(self.a)], self.now[0]-TTL, 'tech'],
                ['topics', namespace('topics'), '', [fingerprint(self.a), fingerprint(self.b)], self.now[0], False]]
        (self.path / 'answers.json').write_bytes(encoded(dict(schema=1, records=rows)))
        store = AnswerCache(self.path, clock=lambda: self.now[0], trace=self.trace, start_writer=False)
        self.assertEqual(len(store.snapshot()), 1)
        self.assertEqual(self.reason('classify', [self.a]), ['cache_expired'])
        self.assertEqual(self.reason('topics', [TopicPair(self.a, self.b)]), ['topic_expand'])

    def test_private_jsonl_retries_and_concurrent_rounds(self):
        self.observe(self.a)
        questions = self.trace.prepare('classify', [self.a])
        def write(i):
            self.trace.http(i//3, 'classify', questions, retry=i % 3 != 0)
        with ThreadPoolExecutor(max_workers=3) as pool:
            list(pool.map(write, range(30)))
        data = (self.path / 'model-trace.jsonl').read_text()
        rows = [json.loads(line) for line in data.splitlines()]
        self.assertEqual(len(rows), 30)
        self.assertEqual(sum(row['retry'] for row in rows), 20)
        self.assertEqual({row['round'] for row in rows}, set(range(10)))
        for row in rows:
            self.assertEqual(row['count'], len(row['questions']))
            self.assertRegex(row['questions'][0]['key'], r'^[a-f0-9]{64}$')
        for secret in (*self.a, 'https://', 'API_KEY'):
            self.assertNotIn(secret, data)
        self.assertEqual(os.stat(self.path / 'model-trace.jsonl').st_mode & 0o777, 0o600)

    def test_rotation_bounded_private_and_readable(self):
        self.trace.max_bytes = 1200
        questions = self.trace.prepare('tone', [self.a])
        for n in range(20):
            self.trace.http(n, 'tone', questions)
        files = list(self.path.glob('model-trace.jsonl*'))
        self.assertEqual(len(files), 2)
        self.assertLessEqual(sum(p.stat().st_size for p in files), 1200)
        rows = [json.loads(line) for p in files for line in p.read_text().splitlines()]
        self.assertIn(19, [r['round'] for r in rows])
        self.assertTrue(all(p.stat().st_mode & 0o777 == 0o600 for p in files))

    def test_write_failure_no_content_and_no_model_failure(self):
        (self.path / 'model-trace.jsonl').symlink_to(self.path / 'private')
        questions = self.trace.prepare('tone', [self.a])
        with ThreadPoolExecutor(max_workers=3) as pool:
            list(pool.map(lambda _: self.trace.http(1, 'tone', questions), range(6)))
        self.assertEqual(self.logs, ['model trace: unavailable; tracing disabled'])
        self.assertFalse((self.path / 'private').exists())

    def test_metadata_tables_bounded(self):
        with patch('back.model_trace.MAX_KNOWLEDGE', 2):
            self.observe(self.a, self.b, ('c', 'c', ''))
            causes = self.observe(('d', 'd', ''))
            self.assertEqual(self.reason('classify', [('d', 'd', '')], item_causes=causes), ['other'])
        self.assertEqual(len(self.trace.versions), 2)
        self.assertEqual(len(self.trace.causes), 2)

    def test_scheduler_actual_http_retry_and_requeue_rows_match_stats(self):
        from tests import test_model_requeue as helpers
        from tests.test_classify import server, answers
        for codes in ([429, 529, 200], [500, 200]):
            with self.subTest(codes=codes), TemporaryDirectory() as directory:
                self.schedulers = []
                trace = ModelTrace(directory)
                def respond(payload, n, _):
                    return codes[n-1], answers(len(payload['state'])) if codes[n-1] == 200 else {}, {}
                try:
                    with server(respond) as (url, received):
                        s, work, _ = helpers.ModelRequeueTests.make(self, url)
                        s.model_trace = trace
                        helpers.ModelRequeueTests.run_to_idle(self, s)
                        rows = [json.loads(l) for l in (Path(directory)/'model-trace.jsonl').read_text().splitlines()]
                        self.assertEqual(len(rows), work.http)
                        self.assertEqual(len(rows), len(codes))
                        self.assertEqual(sum(r['retry'] for r in rows), work.retries)
                        self.assertEqual(sum(r['requeue'] for r in rows), work.requeued)
                        self.assertTrue(all(r['round'] == work.round_id and r['lane'] == 'classify' and r['count'] == 1 for r in rows))
                        if codes[0] == 500:
                            self.assertEqual(rows[1]['questions'][0]['reason'], 'requeue')
                        else:
                            self.assertEqual([r['questions'] for r in rows], [rows[0]['questions']] * 3)
                finally:
                    helpers.ModelRequeueTests.tearDown(self)

    def test_old_disk_read_does_not_erase_known_eviction(self):
        row = ['classify', namespace('classify'), '', [fingerprint(self.a)], self.now[0], 'tech']
        self.trace.cache_row(row, evicted=True)
        self.trace.cache_row(row)
        self.assertEqual(self.reason('classify', [self.a]), ['cache_evicted'])
        self.trace.cache_row(row, acquired=True)
        self.assertEqual(self.reason('classify', [self.a]), ['other'])

    def test_real_observer_three_workers_and_overlapping_rounds(self):
        from collections import Counter
        from tests import test_model_stats as helpers
        from back.scheduler import Scheduler
        self.schedulers = []
        self.gates = []
        def scheduler(*args, **kwargs):
            return Scheduler(*args, **kwargs, model_trace=self.trace)
        try:
            with patch.object(helpers, 'Scheduler', side_effect=scheduler):
                helpers.ModelStatsTests.test_http_attempts_retries_parallel_and_original_round_ownership(self)
            rows = [json.loads(l) for l in (self.path/'model-trace.jsonl').read_text().splitlines()]
            self.assertEqual(Counter(r['round'] for r in rows), {1: 3, 2: 2, 3: 1})
            self.assertEqual(sum(r['retry'] for r in rows), 3)
            self.assertNotIn('stats-fake-key', (self.path/'model-trace.jsonl').read_text())
        finally:
            helpers.ModelStatsTests.tearDown(self)

    def test_trace_enabled_real_five_lane_chaos_keeps_http_and_cache_accounting(self):
        from tests.test_model_chaos import Scenario
        from back.answer_cache import CacheBridge
        scenario = Scenario(47001, 0)
        s = scenario.scheduler
        s.model_trace = self.trace
        store = AnswerCache(self.path, trace=self.trace, start_writer=False)
        s.answer_cache = CacheBridge(store)
        scenario.run()
        rows = [json.loads(l) for l in (self.path/'model-trace.jsonl').read_text().splitlines()]
        self.assertEqual(len(rows), s.total_http)
        self.assertEqual(sum(r['retry'] for r in rows), s.total_retries)
        self.assertTrue({'classify', 'analysis', 'events', 'topics', 'tone'} == {r['lane'] for r in rows})
        self.assertTrue(all(r['count'] == len(r['questions']) for r in rows))
        for lane in ('classify', 'analysis', 'tone'):
            causes = [q['reason'] for r in rows if r['lane'] == lane for q in r['questions']]
            self.assertIn('new_item', causes)
            self.assertNotIn('other', causes)
        self.assertTrue(all(set(q) == {'key', 'reason'} for r in rows for q in r['questions']))
        self.assertNotIn('chaos-fake-key', (self.path/'model-trace.jsonl').read_text())

    def test_reacquired_answer_during_rollback_replaces_future_trace_timestamp(self):
        ns = namespace('classify')
        row = ['classify', ns, '', [fingerprint(self.a)], self.now[0], 'tech']
        self.trace.cache_row(row)
        future = list(row)
        self.now[0] -= 60
        row[4] = self.now[0]
        row[5] = 'world'
        self.trace.cache_row(row, acquired=True)
        self.trace.cache_row(future)  # Flush rereads the old future disk record.
        self.now[0] += TTL
        self.assertEqual(self.reason('classify', [self.a]), ['cache_expired'])

    def test_initial_new_item_origin_survives_classification_and_later_round(self):
        initial = self.observe(self.a)
        self.assertEqual(self.reason('classify', [self.a], item_causes=initial), ['new_item'])
        self.trace.cache_row(['classify', namespace('classify'), '', [fingerprint(self.a)], self.now[0], 'world'], acquired=True)
        later = self.observe(self.a)
        self.assertEqual(self.reason('analysis', [self.a], kind='finance', item_causes=later), ['new_item'] * 3)
        self.assertEqual(self.reason('tone', [self.a], item_causes={}), ['new_item'])
        changed = (self.a[0], self.a[1], 'edited summary')
        self.observe(changed)
        later = self.observe(changed)
        self.assertEqual(self.reason('analysis', [changed], kind='world', item_causes=later), ['content_changed'] * 2)
        self.assertEqual(self.reason('tone', [changed], item_causes={}), ['content_changed'])
        self.assertEqual(self.reason('tone', [self.a], item_causes=initial), ['new_item'])

    def test_known_cache_reasons_override_new_and_changed_origins(self):
        cause = self.observe(self.a)
        row = ['classify', namespace('classify'), '', [fingerprint(self.a)], self.now[0], 'tech']
        self.trace.cache_row(row, evicted=True)
        self.assertEqual(self.reason('classify', [self.a], item_causes=cause), ['cache_evicted'])
        self.now[0] += TTL
        self.assertEqual(self.reason('classify', [self.a], item_causes=cause), ['cache_expired'])
        self.assertEqual(self.reason('classify', [self.a], item_causes=cause, requeued=True), ['requeue'])
