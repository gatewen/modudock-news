from collections import Counter
from types import SimpleNamespace
import threading
import time
import unittest

from back.scheduler import (Scheduler, ModelRound, MODEL_WORKERS, ClassifyResult,
                            EventResult, TopicResult)
from back.events import Pair
from back.topics import TopicPair
from tests.test_scheduler import Sink, eventually


class ModelWorkerTests(unittest.TestCase):
    def setUp(self):
        self.gates = [threading.Event() for _ in range(3)]
        self.calls = []
        self.logs = []
        self.now = [0]
        self.lock = threading.Lock()
        self.handler = lambda lane, batch, index: self.success(lane, batch)
        def call(lane, batch):
            with self.lock:
                index = len(self.calls)
                self.calls.append((lane, batch))
            return self.handler(lane, batch, index)
        self.classifier = SimpleNamespace(enabled=True, clock=lambda:self.now[0], budget=60,
                                          classify=lambda batch:call('classify',batch))
        self.s = Scheduler([{'name':'A','url':'unused'}], None, Sink(), 1,
            classifier=self.classifier,
            analyzer=SimpleNamespace(enabled=True, analyze=lambda batch, **_:call('analysis',batch)),
            matcher=SimpleNamespace(enabled=True, match=lambda batch:call('events',batch)),
            topic_matcher=SimpleNamespace(enabled=True, match=lambda batch:call('topics',batch)),
            tone_client=SimpleNamespace(enabled=True, tone=lambda batch:call('tone',batch)), log=self.logs.append)
        self.work = ModelRound(1)

    def tearDown(self):
        self.s.stop()
        for gate in self.gates:
            gate.set()
        for worker in self.s.classify_workers:
            if worker.ident is not None:
                worker.join(2)
                self.assertFalse(worker.is_alive())

    def success(self, lane, batch):
        if lane in ('events','topics'):
            return {pair.key:False for pair in batch}
        if lane == 'analysis':
            return {key:{'kind':'world','trend':'other','region':'other'} for key,_,_ in batch}
        return {key:'society' if lane=='classify' else 'neutral' for key,_,_ in batch}

    def start(self):
        for worker in self.s.classify_workers:
            worker.start()

    def queue(self, lane, entries):
        selected = next(l for l in self.s.lanes if l.name==lane)
        with self.s.cv:
            for entry in entries:
                selected.jobs.put((self.work, entry))
            self.s.cv.notify_all()

    def accept(self):
        with self.s.cv:
            while self.s.results:
                self.s._accept(self.s.results.popleft())
            self.s._finish_model_rounds()
            self.s.cv.notify_all()
            return not self.work.running and not self.work.awaiting and all(l.jobs.empty() for l in self.s.lanes)

    def block_three(self, lane, batch, index):
        if index<3:
            self.gates[index].wait(3)
        return self.success(lane,batch)

    def test_three_concurrent_batches_dedup_and_one_aggregate_stats_line(self):
        self.handler = self.block_three
        self.s.round_id=1
        self.s.model_work=self.work
        packet={'body':{'items':[{'link':f'https://e.com/{i}','title':f'item {i}',
                                 'summary':'','category':'','source':'A','published':''} for i in range(100)]}}
        # Isolate classification admission while still exercising its real in-flight set.
        self.s.matcher=None
        self.s.topic_matcher=None
        self.s.tone_client=None
        self.s._enqueue_classification(packet)
        self.start()
        eventually(lambda:len(self.calls)==3)
        self.assertEqual(MODEL_WORKERS,3)
        self.assertEqual([w.name for w in self.s.classify_workers],['news-classify-1','news-classify-2','news-classify-3'])
        self.assertTrue(all(w.daemon for w in self.s.classify_workers))
        with self.s.cv:
            self.assertEqual(self.work.running,3)
        self.s._enqueue_classification(packet)
        self.assertEqual(self.s.classify_jobs.qsize(),40)
        self.assertEqual(len(self.s.in_flight),100)
        for gate in self.gates: gate.set()
        eventually(self.accept)
        counts=Counter(key for _,batch in self.calls for key,_,_ in batch)
        self.assertEqual(len(counts),100)
        self.assertEqual(set(counts.values()),{1})
        self.assertEqual(len(self.s.classify_cache),100)
        self.assertFalse(self.s.in_flight)
        for _ in range(3): self.accept()
        self.assertEqual(len(self.logs),1)
        self.assertIn('requests=5 failed=0',self.logs[0])
        self.assertIn('classify=5 analysis=0 events=0 topics=0 tone=0',self.logs[0])

    def test_newly_free_worker_takes_highest_priority_before_queued_low_work(self):
        self.handler=self.block_three
        self.queue('tone',[(str(i),'title','') for i in range(61)])
        self.start()
        eventually(lambda:len(self.calls)==3)
        with self.s.cv:
            self.s.classify_cache['a']='world'
            self.queue('analysis',[('a','a','')])
            self.queue('topics',[TopicPair(('s','s',''),('t','t',''))])
            self.queue('events',[Pair(('l','l',''),('r','r',''),.5)])
            self.queue('classify',[('c','c','')])
        self.gates[0].set()
        def progressed():
            self.accept()
            return len(self.calls)==8
        eventually(progressed)
        self.assertEqual([lane for lane,_ in self.calls],['tone']*3+['classify','events','topics','analysis','tone'])

    def test_unaccepted_dependency_results_block_all_workers(self):
        self.start()
        for result_type in (ClassifyResult,EventResult,TopicResult):
            with self.subTest(result=result_type):
                waiting=set()
                original=self.s.cv.wait
                def observed(timeout=None, wait=original):
                    if self.s.results:
                        waiting.add(threading.current_thread().name)
                    return wait(timeout)
                self.s.cv.wait=observed
                before=len(self.calls)
                with self.s.cv:
                    self.s.results.append(result_type(round_id=-1))
                    self.queue('classify',[(result_type.__name__,'title','')])
                eventually(lambda:len(waiting)==3)
                self.assertEqual(len(self.calls),before)
                with self.s.cv:
                    self.s._accept(self.s.results.popleft())
                    self.s.cv.notify_all()
                eventually(lambda:len(self.calls)==before+1)
                eventually(self.accept)
                self.s.cv.wait=original

    def test_failure_stops_admission_but_accepts_other_inflight_successes(self):
        self.check_admission('failure')

    def test_budget_stops_admission_but_accepts_other_inflight_successes(self):
        self.check_admission('budget')

    def test_auth_shutdown_stops_admission_but_accepts_inflight_results(self):
        self.check_admission('auth')

    def check_admission(self, mode):
        def handler(lane,batch,index):
            self.gates[index].wait(3)
            if index==0 and mode=='failure': return None
            if index==0 and mode=='auth':
                self.classifier.enabled=False
                return None
            return self.success(lane,batch)
        self.handler=handler
        self.queue('classify',[(str(i),'title','') for i in range(80)])
        self.start()
        eventually(lambda:len(self.calls)==3)
        if mode=='budget': self.now[0]=60
        self.gates[0].set()
        eventually(lambda:self.work.running==2)
        self.accept()
        self.assertEqual(self.logs,[])  # No early log when two requests remain in flight.
        for gate in self.gates: gate.set()
        eventually(self.accept)
        self.assertEqual(len(self.calls),3)
        expected={key for _,batch in self.calls[(0 if mode=='budget' else 1):] for key,_,_ in batch}
        self.assertEqual(set(self.s.classify_cache),expected)
        self.assertEqual(len(self.logs),1)
        self.assertIn(f'requests=3 failed={0 if mode=="budget" else 1}',self.logs[0])
        self.assertEqual(self.work.running,0)

    def test_stop_does_not_join_network_blocked_workers_and_all_exit_after_release(self):
        self.handler=self.block_three
        self.queue('classify',[(str(i),'title','') for i in range(60)])
        self.start()
        eventually(lambda:len(self.calls)==3)
        started=time.monotonic()
        self.s.stop()
        self.assertLess(time.monotonic()-started,.1)
        self.assertTrue(all(w.is_alive() for w in self.s.classify_workers))
        for gate in self.gates: gate.set()
        for worker in self.s.classify_workers:
            worker.join(2)
            self.assertFalse(worker.is_alive())
        self.assertEqual(len(self.calls),3)
        self.assertFalse(self.s.results)

    def test_parallel_analysis_inflight_dedup(self):
        self.check_dedup('analysis')

    def test_parallel_events_inflight_dedup(self):
        self.check_dedup('events')

    def test_parallel_topics_inflight_dedup(self):
        self.check_dedup('topics')

    def test_parallel_tone_inflight_dedup(self):
        self.check_dedup('tone')

    def check_dedup(self, lane):
        from unittest.mock import patch
        from tests.test_events import disjoint
        self.handler=self.block_three
        self.s.round_id=1
        self.s.model_work=self.work
        records=[{'link':f'https://e.com/{i}','title':str(i),'summary':'','category':'society','topic':'seed'} for i in range(80)]
        packet={'body':{'items':records,'events':{'pending':0}}}
        pairs=disjoint(40)
        pending=[(records[0]['link'],item['link']) for item in records[1:]]
        self.s._topic_plan=lambda packet:([],pending)
        if lane=='events':
            self.s.topic_matcher=None
            self.s.tone_client=None
        def enqueue():
            with self.s.cv:
                if lane=='analysis':
                    for item in records:
                        self.s.classify_cache[item['link']]='world'
                        self.s._enqueue_analysis(self.work,(item['link'],item['title'],''))
                elif lane=='events': self.s._enqueue_classification(packet)
                elif lane=='topics': self.s._enqueue_topics(packet)
                else: self.s._enqueue_tones(packet)
        with patch('back.scheduler.candidate_pairs',return_value=pairs):
            enqueue(); self.start()
            eventually(lambda:len(self.calls)==3)
            enqueue(); enqueue()
            for gate in self.gates: gate.set()
            eventually(self.accept)
        keys=[item.key if lane in ('events','topics') else item[0] for _,batch in self.calls for item in batch]
        expected={pair.key for pair in pairs} if lane=='events' else set(pending) if lane=='topics' else {i['link'] for i in records}
        self.assertEqual(set(keys),expected)
        self.assertEqual(len(keys),len(expected))
        inflight={'analysis':self.s.analysis_in_flight,'events':self.s.event_in_flight,
                  'topics':self.s.topic_in_flight,'tone':self.s.tone_in_flight}[lane]
        self.assertFalse(inflight)

    def test_http_401_and_403_stop_new_admission_across_workers(self):
        from back.classify import Classifier
        from tests.test_classify import server
        for status in (401,403):
            with self.subTest(status=status):
                gates=[threading.Event() for _ in range(3)]
                def respond(payload,n,_):
                    gates[n-1].wait(3)
                    if n==1: return status,{},{}
                    return 200,{'answers':{name:{'choice':'society','probabilities':{'society':.9}}
                                          for name in payload['questions']}},{}
                with server(respond) as (url,received):
                    client=Classifier(endpoint=url,key='test',log=lambda _:None)
                    s=Scheduler([{'name':'A','url':'unused'}],None,Sink(),1,classifier=client,log=lambda _:None)
                    work=ModelRound(1)
                    for i in range(80): s.classify_jobs.put((work,(str(i),'title','')))
                    for worker in s.classify_workers: worker.start()
                    try:
                        eventually(lambda:len(received)==3)
                        gates[0].set()
                        eventually(lambda:not client.enabled and work.failed)
                        next_work=ModelRound(2)
                        with s.cv:
                            s.classify_jobs.put((next_work,('next-round','title','')))
                            s.cv.notify_all()
                        for gate in gates: gate.set()
                        def finish():
                            with s.cv:
                                while s.results: s._accept(s.results.popleft())
                                s.cv.notify_all()
                                return not work.running and not work.awaiting and s.classify_jobs.empty()
                        eventually(finish)
                        self.assertEqual(len(received),3)
                        self.assertEqual(len(s.classify_cache),40)
                        self.assertEqual(next_work.requests['classify'],0)
                    finally:
                        s.stop()
                        for gate in gates: gate.set()
                        for worker in s.classify_workers:
                            worker.join(2)
                            self.assertFalse(worker.is_alive())

    def test_scheduler_start_launches_all_three_model_workers(self):
        from tests.test_scheduler import FunctionFetcher, ok
        fetch_gate=threading.Event()
        self.s.fetcher=FunctionFetcher(lambda *_:(fetch_gate.wait(3),ok())[1])
        self.handler=self.block_three
        self.queue('classify',[(str(i),'title','') for i in range(60)])
        self.s.start()
        try:
            eventually(lambda:len(self.calls)==3)
            self.assertTrue(all(worker.is_alive() for worker in self.s.classify_workers))
            self.assertEqual(self.work.running,3)
        finally:
            self.s.stop()
            fetch_gate.set()
            for worker in self.s.workers+[self.s.coordinator]:
                worker.join(2)
                self.assertFalse(worker.is_alive())
