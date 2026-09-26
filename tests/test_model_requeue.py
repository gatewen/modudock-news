"""Deferred one-shot batch retry, through real HTTP and scheduler workers."""
from collections import Counter
from types import SimpleNamespace
import threading
import unittest
from unittest.mock import patch

from back.classify import Classifier
from back.scheduler import Scheduler, ModelRound
from tests.test_classify import server, answers
from tests.test_scheduler import eventually, Sink


class ModelRequeueTests(unittest.TestCase):
    def setUp(self):
        self.schedulers = []

    def tearDown(self):
        for s in self.schedulers:
            s.stop()
            for worker in s.classify_workers + s.workers + [s.coordinator]:
                if worker.ident is not None:
                    worker.join(3)
                    self.assertFalse(worker.is_alive())

    def make(self, url, count=1, workers=1, **options):
        logs=[]
        client=Classifier(endpoint=url,key='requeue-test-secret',sleep=lambda _:None,log=lambda _:None,**options)
        with patch('back.scheduler.MODEL_WORKERS',workers):
            s=Scheduler([{'name':'A','url':'unused'}],None,Sink(),1,classifier=client,log=logs.append)
        self.schedulers.append(s)
        s.active=True
        s.round_id=1
        work=s.model_work=ModelRound(1)
        for i in range(count):
            key=f'https://e.test/{i}'
            s.classify_jobs.put((work,(key,str(i),'')))
            s.in_flight.add(key)
        return s,work,logs

    def run_to_idle(self,s,works=None):
        works = works or [s.model_work]
        for worker in s.classify_workers: worker.start()
        def drained():
            with s.cv:
                while s.results: s._accept(s.results.popleft())
                s._finish_model_rounds()
                s.cv.notify_all()
                return all(work.logged for work in works)
        eventually(drained,timeout=5)
        self.assertFalse(s.in_flight)
        self.assertFalse(s.model_rounds)
        self.assertFalse(s.model_running)
        self.assertEqual(s.model_work.awaiting,0)

    def test_500_requeues_exact_batch_after_other_work_and_recovers(self):
        order=[]
        def respond(payload,n,_):
            order.append(tuple(v['title'] for v in payload['state'].values()))
            return (500,{}, {}) if n==1 else (200,answers(len(payload['state'])),{})
        with server(respond) as (url,received):
            s,w,logs=self.make(url,41)
            # An independent lower lane must finish before the deferred classification.
            s.tone_client=SimpleNamespace(enabled=True,tone=lambda batch:order.append(('tone',)) or {'tone':'neutral'})
            s.tone_jobs.put((w,('tone','tone','')))
            s.tone_in_flight.add('tone')
            self.run_to_idle(s)
        self.assertEqual(order,[tuple(map(str,range(20))),tuple(map(str,range(20,40))),('40',),('tone',),tuple(map(str,range(20)))])
        self.assertEqual(len(s.classify_cache),41)
        self.assertFalse(w.failed)
        self.assertEqual(w.failures,0)
        self.assertEqual((w.http,w.retries,w.requeued),(4,0,1))
        self.assertEqual(len(logs),1)
        self.assertIn('failed=0',logs[0]);self.assertIn('requeued=1',logs[0])

    def test_bad_response_retries_once_then_fails_without_partial_cache(self):
        with server(lambda *_:(200,{'answers':{}},{})) as (url,received):
            s,w,logs=self.make(url,20)
            self.run_to_idle(s)
            self.assertEqual(len(received),2)
            self.assertEqual(received[0][2],received[1][2])
        self.assertFalse(s.classify_cache)
        self.assertTrue(w.failed)
        self.assertEqual((w.failures,w.failure_detail,w.requeued,w.http),(1,'response',1,2))
        self.assertEqual(len(logs),1)

    def test_busy_auth_service_and_other_4xx_never_requeue(self):
        for code,attempts in [(429,3),(529,3),(401,1),(403,1),(400,1),(404,1)]:
            with self.subTest(code=code),server(lambda *_:(code,{},{})) as (url,received):
                s,w,_=self.make(url)
                self.run_to_idle(s)
                self.assertEqual(len(received),attempts)
                self.assertEqual(w.requeued,0)
                self.assertEqual(w.failures,1)
                self.assertEqual((w.http,w.retries),(attempts,attempts-1))
                self.assertEqual(s.classifier._state.service_failures,int(code==403))
                self.assertEqual(s.classifier.enabled,code!=401)

    def test_exhausted_budget_does_not_send_retry(self):
        now=[0]
        def respond(*_):
            now[0]=60
            return 500,{},{}
        with server(respond) as (url,received):
            s,w,_=self.make(url,clock=lambda:now[0])
            self.run_to_idle(s)
            self.assertEqual(len(received),1)
            self.assertEqual(w.requeued,0)

    def test_three_parallel_failures_keep_round_ownership_and_retry_each_batch_once(self):
        barrier=threading.Barrier(3)
        calls=Counter();lock=threading.Lock()
        def respond(payload,*_):
            first=payload['state']['news_0']['title']
            with lock:
                calls[first]+=1
                attempt=calls[first]
            barrier.wait(3)  # Three originals AND three deferred retries can overlap.
            if attempt==1:
                return 500,{},{}
            return 200,answers(len(payload['state'])),{}
        with server(respond) as (url,_):
            s,w,logs=self.make(url,60,workers=3)
            self.run_to_idle(s)
        self.assertEqual(calls,{'0':2,'20':2,'40':2})
        self.assertEqual(len(s.classify_cache),60)
        self.assertEqual((w.http,w.requeued,w.failures),(6,3,0))
        self.assertEqual(len(logs),1)

    def test_connection_failure_recovers_and_context_does_not_leak(self):
        for error in (OSError('private URL'),TimeoutError('private key')):
            with self.subTest(error=type(error).__name__),server() as (url,received):
                s,w,logs=self.make(url)
                opener=s.classifier._opener
                attempts=[]
                def open_once(*args,**kwargs):
                    attempts.append(1)
                    if len(attempts)==1: raise error
                    return opener.open(*args,**kwargs)
                s.classifier._opener=SimpleNamespace(open=open_once)
                self.run_to_idle(s)
                self.assertEqual((w.http,w.requeued,w.failures),(2,1,0))
                self.assertEqual(len(received),1)
                self.assertEqual(w.failure_detail,'')
                self.assertNotIn('private','\n'.join(logs))

    def test_budget_expires_while_other_work_runs_and_releases_held_batch(self):
        now=[0]
        with server(lambda *_:(500,{},{})) as (url,received):
            s,w,_=self.make(url,clock=lambda:now[0])
            def tone(batch):
                now[0]=60
                return {'tone':'neutral'}
            s.tone_client=SimpleNamespace(enabled=True,tone=tone)
            s.tone_jobs.put((w,('tone','tone','')))
            self.run_to_idle(s)
            self.assertEqual(len(received),1)
            self.assertFalse(s.model_requeues)
            self.assertEqual((w.requeued,w.failures),(0,0))
            self.assertEqual(s._model_state({'classify':{'pending':1}}),{'state':'paused','reason':'budget'})

    def test_old_round_requeue_keeps_original_deadline_and_statistics(self):
        order=[]
        def respond(payload,n,_):
            order.append(payload['state']['news_0']['title'])
            return (500,{}, {}) if n==1 else (200,answers(1),{})
        with server(respond) as (url,received):
            s,w,logs=self.make(url)
            next_work=ModelRound(2)
            s.model_work=next_work;s.round_id=2
            s.classify_jobs.put((next_work,('new','new','')));s.in_flight.add('new')
            self.run_to_idle(s,[w,next_work])
        self.assertEqual(order,['0','new','0'])
        self.assertEqual((w.http,w.requeued,next_work.http,next_work.requeued),(2,1,1,0))
        self.assertEqual(len(logs),2)
        self.assertEqual(s.total_http,3)

    def test_pair_requeue_blocks_topics_but_allows_independent_analysis(self):
        from back.classify import _retryable_failure, _failure_detail
        from back.events import Pair
        from back.topics import TopicPair
        with server() as (url,_):
            s,w,logs=self.make(url,count=0)
            order=[]
            pair=Pair(('a','A',''),('b','B',''),.5)
            topic=TopicPair(('a','A',''),('c','C',''))
            def match(batch):
                order.append('events')
                if order==['events']:
                    _failure_detail.set('response');_retryable_failure.set(True)
                    return None
                return {p.key:False for p in batch}
            s.matcher=SimpleNamespace(enabled=True,match=match)
            s.analyzer=SimpleNamespace(enabled=True,analyze=lambda *_,**__:order.append('analysis') or {})
            s.topic_matcher=SimpleNamespace(enabled=True,match=lambda batch:order.append('topics') or {p.key:False for p in batch})
            s.event_jobs.put((w,pair));s.event_in_flight.add(pair.key)
            s.topic_jobs.put((w,topic));s.topic_in_flight.add(topic.key)
            s.classify_cache['x']='finance';s.analysis_jobs.put((w,('x','X','')))
            self.run_to_idle(s)
        self.assertEqual(order,['events','analysis','events','topics'])
        self.assertFalse(s.event_in_flight);self.assertFalse(s.topic_in_flight)
        self.assertFalse(s.model_requeues)
        self.assertEqual(w.requeued,1)

    def test_half_open_probe_failure_never_creates_a_second_probe(self):
        with server(lambda *_:(500,{},{})) as (url,received):
            s,w,_=self.make(url,clock=lambda:1800)
            s.classifier._state.service_failures=3
            s.classifier._state.service_probe_at=1800
            self.run_to_idle(s)
            self.assertEqual(len(received),1)
            self.assertEqual(w.requeued,0)

    def test_full_round_failed_twenty_items_recover_without_paused_list_or_extra_publish(self):
        from tests.test_scheduler import FunctionFetcher, analysis_feed
        def respond(payload,n,_):
            if n==1: return 500,{},{}
            return 200,{'answers':{f'item_{i}':{'choice':'society','probabilities':{'society':.9}}
                                  for i in range(len(payload['state']))}},{}
        with server(respond) as (url,received):
            client=Classifier(endpoint=url,key='fake-test',log=lambda _:None)
            sink=Sink();logs=[]
            s=Scheduler([{'name':'0','url':'unused'}],FunctionFetcher(lambda *_:analysis_feed([f'report-{i}' for i in range(20)])),sink,1,
                        classifier=client,log=logs.append)
            self.schedulers.append(s);s.start()
            eventually(lambda:s.last_list is not None and s.last_list['body']['model']['state']=='done'
                       and any(line.startswith('model ') for line in logs),timeout=5)
            packets=[]
            while not sink.packets.empty(): packets.append(sink.packets.get_nowait())
            lists=[p['body'] for p in packets if p['t']=='msg']
            self.assertEqual(len(received),2)
            self.assertEqual(len(s.classify_cache),20)
            self.assertEqual(lists[-1]['classify']['pending'],0)
            self.assertEqual({body['model']['state'] for body in lists},{'working','done'})
            self.assertEqual(sum(p['t']=='publish' for p in packets),1)
            self.assertEqual(len({body['at'] for body in lists}),1)
            self.assertFalse(s.model_requeues);self.assertFalse(s.in_flight)
            self.assertIn('requests=2 failed=0',next(line for line in logs if line.startswith('model ')))

    def test_newer_round_budget_cannot_extend_original_retry_deadline(self):
        now=[0]
        def respond(payload,n,_):
            now[0]=50 if n==1 else 70
            return (500,{}, {}) if n==1 else (200,answers(1),{})
        with server(respond) as (url,received):
            s,w,_=self.make(url,clock=lambda:now[0])
            newer=ModelRound(2);s.model_work=newer;s.round_id=2
            s.classify_jobs.put((newer,('new','new','')));s.in_flight.add('new')
            self.run_to_idle(s,[w,newer])
            self.assertEqual(len(received),2)
            self.assertEqual((w.deadline,newer.deadline),(60,110))
            self.assertEqual((w.http,w.requeued,w.failures),(1,0,0))
            self.assertEqual(newer.http,1)

    def test_deferred_batch_with_rate_limit_retries_keeps_counters_distinct(self):
        codes=[500,429,529,200]
        with server(lambda p,n,_:(codes[n-1],answers(len(p['state'])),{})) as (url,received):
            s,w,logs=self.make(url)
            self.run_to_idle(s)
            self.assertEqual(len(received),4)
        self.assertEqual((w.requests['classify'],w.http,w.retries,w.requeued,w.failures),(2,4,2,1,0))
        self.assertEqual((s.total_http,s.total_retries),(4,2))
        self.assertIn('http=4 retries=2',logs[0])

    def test_requeue_receiving_403_counts_service_round_only_once(self):
        with server(lambda p,n,_:(500 if n==1 else 403,{},{})) as (url,received):
            s,w,_=self.make(url)
            self.run_to_idle(s)
            self.assertEqual(len(received),2)
        self.assertEqual((w.requeued,w.failures,w.failure_detail),(1,1,'service'))
        self.assertEqual(s.classifier._state.service_failures,1)
        self.assertEqual(s.classifier._state.service_rounds,{w.round_id})
