"""Round overlap and queue saturation, using real workers with fake clients."""
from copy import deepcopy
from types import SimpleNamespace
import threading
import time
import unittest
from unittest.mock import patch

from back.scheduler import Scheduler, ModelRound, Cache
from back.events import candidate_pairs
from back.topics import TopicPair
from tests.test_events import article
from tests.test_scheduler import Sink, eventually


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.schedulers = []
        self.gates = []

    def tearDown(self):
        for s in self.schedulers:
            s.stop()
        for gate in self.gates:
            gate.set()
        for s in self.schedulers:
            for thread in s.classify_workers + [s.coordinator]:
                if thread.ident is not None:
                    thread.join(3)
                    self.assertFalse(thread.is_alive())

    def make(self, items, lane='classify'):
        now, calls, logs = [0], [], []
        gate = threading.Event()
        self.gates.append(gate)
        def answer(batch):
            if lane in ('events', 'topics'):
                return {p.key: False for p in batch}
            if lane == 'analysis':
                return {k: {'kind':'world','trend':'other','region':'other'} for k, _, _ in batch}
            return {k: 'society' if lane == 'classify' else 'neutral' for k, _, _ in batch}
        def call(batch, **_):
            calls.append(batch)
            if len(calls) == 1:
                gate.wait(3)
                return None
            return answer(batch)
        classifier = SimpleNamespace(enabled=True, clock=lambda: now[0], budget=60, classify=call)
        clients = {}
        if lane != 'classify':
            field, method = {'analysis':('analyzer','analyze'), 'events':('matcher','match'),
                             'topics':('topic_matcher','match'), 'tone':('tone_client','tone')}[lane]
            clients[field] = SimpleNamespace(enabled=True, **{method:call})
        s = Scheduler([{'name':'甲','url':'unused'}], None, Sink(), 1, classifier=classifier, log=logs.append, **clients)
        self.schedulers.append(s)
        s.round_id = 1
        s.model_work = ModelRound(1)
        if lane != 'classify':
            s.classify_cache.update({i['link']: 'world' if lane == 'analysis' else 'society' for i in items})
        packet = {'t':'msg','seq':1,'body':{'op':'list','items':deepcopy(items),'sources':[],'at':'fixed'}}
        return s, packet, calls, logs, now, gate

    def pump(self, s):
        with s.cv:
            while s.results:
                packet = s._accept(s.results.popleft())
                if packet is not None:
                    s.last_list = packet
            s._finish_model_rounds()
            s.cv.notify_all()
            return not any((s.in_flight, s.analysis_in_flight, s.event_in_flight,
                            s.topic_in_flight, s.tone_in_flight))

    def test_old_failed_batches_retry_under_current_work_for_all_five_lanes(self):
        for lane in ('classify','analysis','events','topics','tone'):
            with self.subTest(lane=lane):
                items = [article(0, title='abcdef'), article(1, title='abghij')]
                s, packet, calls, logs, now, gate = self.make(items, lane)
                seed, target = (i['link'] for i in items)
                topic = {'id':'a'*12,'title':'topic','sources':3,'count':2,'keys':[seed,target]}
                plan = lambda *_: ([topic], [] if (seed,target) in s.topic_cache else [(seed,target)])
                with patch.object(s, '_topic_plan', side_effect=plan):
                    s.last_list = s._decorate(packet)
                    s._enqueue_classification(s.last_list)
                    for w in s.classify_workers: w.start()
                    eventually(lambda: len(calls) == 1)
                    old = s.model_work
                    with s.cv:
                        s.round_id = 2
                        s.model_work = ModelRound(2)
                        s.last_list = s._decorate(packet)
                        s._enqueue_classification(s.last_list)
                        self.assertTrue(all(l.jobs.empty() for l in s.lanes))
                    gate.set()
                    eventually(lambda: self.pump(s) and len(calls) == 2)
                    self.assertTrue(old.failed)
                    self.assertFalse(s.model_work.failed)
                    self.assertEqual(s.last_list['body']['model']['state'], 'done')
                    self.assertEqual(len(logs), 2)
                    self.assertIn('model round=2', logs[-1])
                    s.stop()

    def test_old_expired_classification_success_starts_current_analysis(self):
        s, packet, calls, logs, now, gate = self.make([article(0)])
        s.classifier.classify = lambda batch: (gate.wait(3), {k:'world' for k,_,_ in batch})[1]
        analyses = []
        s.analyzer = SimpleNamespace(enabled=True, analyze=lambda batch, **_: (analyses.append(batch),
            {k:{'kind':'world','trend':'other','region':'other'} for k,_,_ in batch})[1])
        s.last_list = s._decorate(packet)
        s._enqueue_classification(s.last_list)
        for w in s.classify_workers: w.start()
        eventually(lambda: s.model_work.running == 1)
        old = s.model_work
        with s.cv:
            now[0] = 61
            s.round_id = 2
            s.model_work = ModelRound(2)
            s.last_list = s._decorate(packet)
            s._enqueue_classification(s.last_list)
        gate.set()
        eventually(lambda: self.pump(s) and bool(analyses))
        self.assertEqual(old.requests['analysis'], 0)
        self.assertEqual(s.model_work.requests['analysis'], 1)
        self.assertEqual(s.last_list['body']['model']['state'], 'done')

    def test_event_queue_refills_all_candidates_beyond_six_hundred(self):
        suffix = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥天地玄黃宇宙洪荒日月盈昃辰宿列張寒來暑往秋收冬藏'
        items = [article(i, title='美國聯準會宣布升息'+suffix[i]+suffix[(i*7)%len(suffix)]+suffix[(i*13)%len(suffix)]) for i in range(40)]
        s, packet, calls, logs, now, gate = self.make(items, 'events')
        s.matcher.match = lambda batch: (calls.append(batch), {p.key:False for p in batch})[1]
        expected = {p.key for p in candidate_pairs(items) if not p.automatic}
        self.assertGreater(len(expected), 600)
        s.last_list = s._decorate(packet)
        s._enqueue_classification(s.last_list)
        self.assertEqual(s.event_jobs.qsize(), 600)
        for w in s.classify_workers: w.start()
        eventually(lambda: self.pump(s), timeout=10)
        asked = [p.key for batch in calls for p in batch]
        self.assertEqual(set(asked), expected)
        self.assertEqual(len(asked), len(expected))
        self.assertEqual(s.last_list['body']['events']['pending'], 0)
        self.assertEqual(s.last_list['body']['model']['state'], 'done')
        self.assertEqual(len(logs), 1)

    def test_waiting_and_deadline_timer_resend_without_result_or_duplicate_stats(self):
        s, packet, _, logs, now, _ = self.make([article(0)])
        s.last_list = s._decorate(packet)
        self.assertEqual(s.last_list['body']['model'], {'state':'paused','reason':'waiting'})
        s.model_clock = time.monotonic
        work = s.model_work
        work.started = time.monotonic()
        work.deadline = work.started + .08
        s.model_rounds[1] = work
        s.next_round = s.clock() + 100
        s.coordinator.start()
        eventually(lambda: s.last_list['body']['model']['reason'] == 'budget')
        packet = s.outbox.packets.get(timeout=1)
        self.assertEqual(packet['body']['at'], 'fixed')
        self.assertEqual(packet['body']['model'], {'state':'paused','reason':'budget'})
        self.assertTrue(s.outbox.packets.empty())
        self.assertEqual(len(logs), 1)
        # A logged round can be encountered again but must never be registered twice.
        s.model_clock = lambda: 0
        s._enqueue_classification(s.last_list)
        s.classifier.classify = lambda batch: {k:'society' for k,_,_ in batch}
        for w in s.classify_workers: w.start()
        eventually(lambda: s.last_list['body']['model']['state'] == 'done')
        self.assertEqual(len(logs), 1)
        self.assertNotIn(work.round_id, s.model_rounds)

    def test_old_expired_queued_batch_is_released_and_retried(self):
        s, packet, calls, logs, now, _ = self.make([article(0)])
        s.classifier.classify = lambda batch: (calls.append(batch), {k:'society' for k,_,_ in batch})[1]
        s.last_list = s._decorate(packet)
        s._enqueue_classification(s.last_list)
        old = s.model_work
        old.deadline = 60
        now[0] = 61
        s.round_id = 2
        s.model_work = ModelRound(2)
        s.last_list = s._decorate(packet)
        s._enqueue_classification(s.last_list)
        self.assertEqual(s.classify_jobs.qsize(), 1)  # Still only the old queued work.
        for w in s.classify_workers: w.start()
        eventually(lambda: self.pump(s) and bool(calls))
        self.assertEqual(len(calls), 1)
        self.assertEqual(old.requests['classify'], 0)
        self.assertEqual(s.model_work.requests['classify'], 1)
        self.assertEqual(s.last_list['body']['model']['state'], 'done')

    def test_rejected_list_rolls_back_reserved_jobs_before_http(self):
        s, _, calls, _, _, _ = self.make([article(0)])
        s.outbox.put = lambda _: False
        for w in s.classify_workers: w.start()
        self.assertIsNone(s._emit([Cache([article(0)])], []))
        with s.cv:
            self.assertFalse(s.in_flight)
            self.assertTrue(all(l.jobs.empty() for l in s.lanes))
            self.assertEqual(calls, [])
            self.assertIsNone(s.last_list)

    def test_initial_output_gate_blocks_http_without_blocking_stop(self):
        s, _, calls, _, _, gate = self.make([article(0)])
        entered = threading.Event()
        def put(_):
            entered.set()
            gate.wait(3)
            return True
        s.outbox.put = put
        for w in s.classify_workers: w.start()
        emitting = threading.Thread(target=lambda: s._emit([Cache([article(0)])], []))
        emitting.start()
        try:
            self.assertTrue(entered.wait(1))
            with s.cv:
                self.assertEqual(calls, [])
                self.assertFalse(s.model_work.admitted)
                self.assertFalse(s.classify_jobs.empty())
            start = time.monotonic()
            s.stop()
            self.assertLess(time.monotonic() - start, .1)
        finally:
            gate.set()
            emitting.join(3)
            self.assertFalse(emitting.is_alive())

    def test_first_request_notifies_coordinator_to_schedule_deadline_wake(self):
        s, packet, _, _, _, gate = self.make([article(0)])
        s.model_clock = time.monotonic
        s.model_budget = .05
        s.last_list = s._decorate(packet)
        s._enqueue_classification(s.last_list)
        s.last_list = s._decorate(s.last_list)
        s.next_round = s.clock() + 100
        sleeping, expired = threading.Event(), threading.Event()
        original_wait, original_state = s.cv.wait, s._model_state
        def wait(timeout=None):
            if threading.current_thread() is s.coordinator and s.model_work.deadline is None:
                sleeping.set()
            return original_wait(timeout)
        def state(body):
            if s.model_work.deadline is not None and time.monotonic() >= s.model_work.deadline:
                expired.set()
            return original_state(body)
        s.cv.wait, s._model_state = wait, state
        s.coordinator.start()
        self.assertTrue(sleeping.wait(1))
        for w in s.classify_workers: w.start()
        self.assertTrue(expired.wait(1))
        self.assertFalse(gate.is_set())
        self.assertEqual(s.last_list['body']['model']['state'], 'working')  # HTTP is still in flight.
