from types import SimpleNamespace
import unittest
from unittest.mock import patch

from back.scheduler import Scheduler, ModelRound
from back.events import Pair
from back.topics import TopicPair
from tests.test_classify import server
from tests.test_topics import snapshot, story, response
from tests.test_tone import tone_response
from tests import test_tone_scheduler as tone_helpers
from tests.test_scheduler import eventually


class ModelStatsTests(unittest.TestCase):
    setUp = tone_helpers.ToneSchedulerTests.setUp
    tearDown = tone_helpers.ToneSchedulerTests.tearDown
    make = tone_helpers.ToneSchedulerTests.make

    @patch("back.scheduler.MODEL_WORKERS", 1)  # Serial regression; parallel admission covered in test_model_workers.
    def test_snowball_round_logs_once_after_all_results_and_cache_only_round_is_silent(self):
        items, _ = snapshot([story('one', 'ALPHA BETA'), story('two', 'BETA DELTA')])
        def respond(payload, *_):
            return tone_response(payload) if 'q_0' in payload['questions'] else response(payload)
        with server(respond) as (url, received):
            s, _ = self.make(url, items)
            logs = []
            s.log = lambda line: logs.append(line) if line.startswith('model ') else None
            s.start()
            eventually(lambda: len(logs) == 1 and s.last_list['body']['topics']['tone_pending'] == 0, timeout=5)
            self.assertRegex(logs[0], r'^model round=1 requests=3 failed=0 elapsed=\d+\.\ds classify=0 analysis=0 events=0 topics=2 tone=1 http=3 retries=0 total_http=3 total_retries=0 requeued=0$')
            self.assertEqual(s.last_list['body']['topics']['tone_pending'], 0)
            s.refresh()
            eventually(lambda: s.completed == 2)
            with s.cv:
                s._finish_model_rounds()
            self.assertEqual(len(logs), 1)
            self.assertEqual(len(received), 3)

    def test_counts_failures_budget_and_exception_sanitization(self):
        for budget, failure in [(100, None), (80, None), (100, 'none'), (100, 'exception')]:
            with self.subTest(budget=budget, failure=failure):
                now, logs = [0], []
                def client(label, method):
                    def request(*args, **kwargs):
                        now[0] += 20
                        if label == 'analysis' and failure:
                            if failure == 'exception':
                                raise RuntimeError('SECRET https://private.invalid NEWS-CONTENT')
                            return None
                        return {}
                    return SimpleNamespace(enabled=True, **{method:request})
                classifier = client('classify', 'classify')
                classifier.clock = lambda: now[0]
                classifier.budget = budget
                s = Scheduler([{'name':'A','url':'unused'}], None, None, 1, classifier=classifier,
                              analyzer=client('analysis','analyze'), matcher=client('events','match'),
                              topic_matcher=client('topics','match'), tone_client=client('tone','tone'), log=logs.append)
                work = ModelRound(7)
                queues = [s.classify_jobs, s.analysis_jobs, s.event_jobs, s.topic_jobs, s.tone_jobs]
                s.classify_cache['a'] = 'finance'
                for jobs, item in zip(queues, [('c','NEWS-CONTENT',''), ('a','NEWS-CONTENT',''),
                    Pair(('l','l',''),('r','r',''),.5), TopicPair(('seed','s',''),('t','t','')), ('tone','SECRET','')]):
                    jobs.put((work,item))
                def submit(result):
                    with s.cv:
                        s._accept(result)
                        s._finish_model_rounds()
                        return any(not jobs.empty() for jobs in queues)
                s._submit_classification = submit
                s._classify_worker()
                stats = [line for line in logs if line.startswith('model ')]
                count = 4 if failure or budget == 80 else 5
                self.assertEqual(stats, [f'model round=7 requests={count} failed={int(bool(failure))} elapsed={count*20:.1f}s '
                    f'classify=1 analysis=1 events=1 topics=1 tone={int(not failure and budget==100)} http=0 retries=0 total_http=0 total_retries=0 requeued=0'])
                self.assertFalse(s.model_rounds)
                self.assertFalse(any(secret in '\n'.join(logs) for secret in ['SECRET','private.invalid','NEWS-CONTENT']))

    def test_http_attempts_retries_parallel_and_original_round_ownership(self):
        import io
        import json
        import threading
        from collections import Counter
        from back.classify import Classifier
        from tests.test_classify import answers

        entered = threading.Barrier(3)
        attempts = Counter()
        lock = threading.Lock()
        codes = {'a': [429, 529, 200], 'b': [429, 200], 'c': [200]}
        class Response(io.BytesIO):
            def __init__(self, code):
                super().__init__(json.dumps(answers(1)).encode())
                self.code, self.length = code, None
        class Opener:
            def open(self, request, timeout):
                title = json.loads(request.data)['state']['news_0']['title']
                with lock:
                    n = attempts[title]
                    attempts[title] += 1
                if n == 0:
                    entered.wait(2)  # All three workers genuinely overlap.
                return Response(codes[title][n])
        client = Classifier(key='stats-fake-key', sleep=lambda _:None, log=lambda _:None)
        client._opener = Opener()
        logs = []
        s = Scheduler([{'name':'A','url':'unused'}], None, None, 1, classifier=client, log=logs.append)
        self.schedulers.append(s)
        s.active = True
        works = [ModelRound(i) for i in (1,2,3)]
        for work, title in zip(works, 'abc'):
            s.classify_jobs.put((work, (title,title,'')))
        s.model_work = ModelRound(99)  # Refresh must never steal old request counters.
        for worker in s.classify_workers: worker.start()
        def complete():
            with s.cv:
                while s.results:
                    s._accept(s.results.popleft())
                s._finish_model_rounds()
                s.cv.notify_all()
                return len(logs) == 3
        eventually(complete)
        self.assertEqual([(w.requests['classify'],w.http,w.retries) for w in works],
                         [(1,3,2),(1,2,1),(1,1,0)])
        self.assertEqual((s.model_work.http,s.model_work.retries),(0,0))
        self.assertEqual((s.total_http,s.total_retries),(6,3))
        for work in works:
            line = next(line for line in logs if f'round={work.round_id} ' in line)
            self.assertIn(f'http={work.http} retries={work.retries} ',line)
            self.assertIn('requests=1 ',line)
        self.assertIn('total_http=6 total_retries=3',logs[-1])
        self.assertNotIn('stats-fake-key','\n'.join(logs))
        # Context cleanup: an independent client call on this thread has no owner.
        client._opener = SimpleNamespace(open=lambda *_a,**_k:Response(200))
        self.assertIsNotNone(client.classify([('outside','outside','')]))
        self.assertEqual(s.total_http,6)

    def test_http_counts_connection_failure_but_not_preflight_rejection(self):
        from back.classify import Classifier
        client = Classifier(key='stats-fake-key', log=lambda _:None)
        def fail(*_args, **_kwargs):
            raise OSError('secret-bearing connection error')
        client._opener = SimpleNamespace(open=fail)
        logs = []
        s = Scheduler([{'name':'A','url':'unused'}], None, None, 1, classifier=client, log=logs.append)
        work = ModelRound(1)
        s.classify_jobs.put((work, ('key','title','')))
        def submit(result):
            with s.cv:
                s._accept(result)
                s._finish_model_rounds()
            return False
        s._submit_classification = submit
        s._classify_worker()
        self.assertEqual((work.http,work.retries,work.failures),(2,0,1))
        self.assertIn('requests=2 ',logs[0])
        self.assertIn('http=2 retries=0 total_http=2',logs[0])
        self.assertNotIn('secret-bearing','\n'.join(logs))
        # An admitted batch may fail TLS preflight without calling HTTP at all.
        client.has_ca = False
        second = ModelRound(2)
        s.classify_jobs.put((second, ('key2','title','')))
        s._classify_worker()
        self.assertEqual((second.http,second.retries),(0,0))
        self.assertIn('http=0 retries=0 total_http=2',logs[-1])

    def test_deferred_topic_then_real_tone_closes_round_with_http_stats(self):
        from back.classify import Classifier
        from back.topics import ToneClient
        for registered in (False, True):
            with self.subTest(registered=registered):
                def respond(payload, number, _):
                    return (429 if number == 1 else 529, {}, {}) if number < 3 else tone_response(payload)
                with server(respond) as (url, received):
                    logs=[]
                    client=Classifier(endpoint=url,key='deferred-secret',sleep=lambda _:None,log=lambda _:None)
                    s=Scheduler([{'name':'A','url':'unused'}],None,None,1,classifier=client,
                        matcher=SimpleNamespace(enabled=True),topic_matcher=SimpleNamespace(enabled=True),
                        tone_client=ToneClient(shared=client),log=logs.append)
                    self.schedulers.append(s)
                    s.active=True; s.round_id=2
                    s.model_work=ModelRound(2,failed=True)
                    s.last_list={'body':{'events':{'pending':1},'items':[
                        {'link':f'https://e.test/{i}','title':title,'summary':'','source':'A',
                         'published':'2026-09-21T00:00:00Z'} for i,title in enumerate(
                            ('台積電宣布擴大投資計畫','台積電宣布擴大海外布局'))]}}
                    work=ModelRound(1)
                    if registered:
                        # A previous batch finished, but queued topic/tone work
                        # keeps this round registered and not yet logged.
                        work.started=client.clock();work.requests['classify']=1
                        s.model_rounds[1]=work
                    pair=TopicPair(('a','seed',''),('b','candidate',''))
                    s.topic_in_flight.add(pair.key);s.topic_jobs.put((work,pair))
                    s.tone_in_flight.add('x');s.tone_jobs.put((work,('x','tone','')))
                    s.classify_workers[0].start()
                    def drain():
                        with s.cv:
                            while s.results: s._accept(s.results.popleft())
                            s._finish_model_rounds();s.cv.notify_all()
                            return (s.topic_jobs.empty() and s.tone_jobs.empty()
                                    and not s.topic_in_flight and not s.tone_in_flight)
                    eventually(drain)
                    self.assertEqual(work.awaiting,0)
                    self.assertEqual(work.running,0)
                    self.assertTrue(work.logged)
                    self.assertFalse(s.model_rounds)
                    self.assertEqual(len(logs),1)
                    self.assertIn(f'requests={1+int(registered)} ',logs[0])
                    self.assertIn('topics=0 tone=1 http=3 retries=2 total_http=3 total_retries=2',logs[0])
                    self.assertEqual(len(received),3)
                    self.assertFalse(work.failed)
