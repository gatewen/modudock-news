from concurrent.futures import ThreadPoolExecutor
import threading
import time
import unittest

from back.analyze import Analyzer
from back.classify import Classifier
from back.events import EventMatcher, Pair
from tests.test_classify import server, answers, items
from tests.test_analyze import answers as finance_answers
from tests.test_events import answers as pair_answers


class ReentrantClientTests(unittest.TestCase):
    def test_same_analyzer_concurrently_keeps_finance_and_world_context(self):
        barrier = threading.Barrier(2)
        def respond(payload, *_):
            barrier.wait(timeout=3)  # Both requests must be in flight together.
            if 'market_0' in payload['questions']:
                return 200, finance_answers(1), {}
            time.sleep(.04)
            return 200, {'answers': {
                'trend_0': {'choice':'escalation', 'probabilities':{'escalation':.9}},
                'region_0': {'choice':'us_china', 'probabilities':{'us_china':.9}},
            }}, {}
        with server(respond) as (url, received), ThreadPoolExecutor(2) as pool:
            client = Analyzer(endpoint=url, key='secret', timeout=2, log=lambda _: None)
            finance = pool.submit(client.analyze, [('f','finance','')], kind='finance')
            world = pool.submit(client.analyze, [('w','world','')], kind='world')
            self.assertEqual(world.result(timeout=4), {'w':{'kind':'world','trend':'escalation','region':'us_china'}})
            self.assertEqual(finance.result(timeout=4), {'f':{'kind':'finance','market':'positive','theme':'memory','dir':'bull','dir_p':.8}})
            self.assertEqual(len(received), 2)

    def test_same_matcher_concurrently_keeps_distinct_pair_context(self):
        barrier = threading.Barrier(2)
        def respond(payload, *_):
            barrier.wait(timeout=3)
            first = payload['state']['news_0']['title'] == 'first'
            if first:
                time.sleep(.04)
            return 200, pair_answers(payload, choice='same' if first else 'different'), {}
        first = [Pair(('a','first',''),('b','second',''),.5)]
        second = [Pair(('x','third',''),('y','fourth',''),.5), Pair(('y','fourth',''),('z','fifth',''),.5)]
        with server(respond) as (url, received), ThreadPoolExecutor(2) as pool:
            client = EventMatcher(endpoint=url, key='secret', timeout=2, log=lambda _: None)
            one = pool.submit(client.match, first)
            two = pool.submit(client.match, second)
            self.assertEqual(two.result(timeout=4), {pair.key:False for pair in second})
            self.assertEqual(one.result(timeout=4), {first[0].key:True})
            self.assertEqual(len(received), 2)


class RateLimitTests(unittest.TestCase):
    def test_429_then_success_retries_same_payload(self):
        sleeps, logs = [], []
        with server(lambda p,n,_: (429, b'SECRET', {}) if n==1 else (200,answers(),{})) as (url, received):
            client = Classifier(endpoint=url, key='SECRET', sleep=sleeps.append, log=logs.append)
            self.assertEqual(client.classify(items()), {key:'tech' for key,_,_ in items()})
            self.assertEqual(len(received), 2)
            self.assertEqual(received[0][2], received[1][2])
        self.assertEqual(sleeps, [.5])
        self.assertEqual(logs, ['classify: rate limited, retry'])

    def test_529_three_attempts_then_failure(self):
        sleeps, logs = [], []
        with server(lambda *_:(529,b'SECRET',{})) as (url, received):
            client = Classifier(endpoint=url, key='SECRET', sleep=sleeps.append, log=logs.append)
            self.assertIsNone(client.classify(items()))
            self.assertEqual(len(received),3)
            self.assertTrue(client.enabled)
        self.assertEqual(sleeps,[.5,1])
        self.assertEqual(logs,['classify: rate limited, retry']*2+['classify: rate limited'])

    def test_retry_deadline_includes_responses_and_sleep(self):
        for budget, oversleep, expected in [(.5,False,1),(1.5,False,2),(1,True,1)]:
            with self.subTest(budget=budget,oversleep=oversleep):
                now, sleeps, logs = [0], [], []
                def sleep(delay):
                    sleeps.append(delay)
                    now[0] += 2 if oversleep else delay
                with server(lambda *_:(429,{},{})) as (url, received):
                    client = Classifier(endpoint=url,key='secret',clock=lambda:now[0],sleep=sleep,
                                        read_deadline=budget,log=logs.append)
                    self.assertIsNone(client.classify(items()))
                    self.assertEqual(len(received),expected)
                self.assertEqual(logs[-1],'classify: rate limited')
                self.assertEqual(sleeps, [] if budget==.5 else [.5])

    def test_auth_failure_never_retries_and_disables_shared_clients(self):
        for status in (401,):
            sleeps=[]
            with server(lambda *_:(status,{},{})) as (url, received):
                client=Classifier(endpoint=url,key='secret',sleep=sleeps.append,log=lambda _:None)
                analyzer=Analyzer(shared=client)
                self.assertIs(analyzer.sleep,client.sleep)
                self.assertIsNone(client.classify(items()))
                self.assertFalse(analyzer.enabled)
                self.assertIsNone(analyzer.analyze(items()))
                self.assertEqual(len(received),1)
                self.assertEqual(sleeps,[])

    def test_slow_rate_limit_response_does_not_reset_deadline(self):
        now, sleeps, logs = [0], [], []
        def respond(*_):
            now[0] = 2
            return 429, {}, {}
        with server(respond) as (url, received):
            client=Classifier(endpoint=url,key='secret',clock=lambda:now[0],sleep=sleeps.append,
                              read_deadline=1,log=logs.append)
            self.assertIsNone(client.classify(items()))
            self.assertEqual(len(received),1)
        self.assertEqual(sleeps,[])
        self.assertEqual(logs,['classify: rate limited'])
