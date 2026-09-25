from copy import deepcopy
from types import SimpleNamespace
import unittest

from back.scheduler import Scheduler, ModelRound, ToneResult
from back.topics import ToneClient, TopicPair
from back.events import Pair
from back.feedparse import MAX_PACKET, packet_bytes
from tests import test_topic_scheduler as topic_helpers
from tests.test_topics import snapshot, story, response
from tests.test_tone import tone_response
from tests.test_classify import server
from tests.test_scheduler import eventually


class ToneSchedulerTests(unittest.TestCase):
    setUp = topic_helpers.TopicSchedulerTests.setUp
    tearDown = topic_helpers.TopicSchedulerTests.tearDown

    def make(self, url, items, **options):
        s, sink = topic_helpers.TopicSchedulerTests.make(self, url, items, **options)
        s.tone_client = ToneClient(shared=s.classifier)
        return s, sink

    def test_topic_members_all_categories_only_once_after_topics_and_resend_counts_reports(self):
        items, _ = snapshot([story('one','ALPHA BETA'), story('two','BETA DELTA')])
        kinds = []
        def respond(payload, *_):
            kinds.append('tone' if 'q_0' in payload['questions'] else 'topics')
            return tone_response(payload) if kinds[-1]=='tone' else response(payload)
        with server(respond) as (url, received):
            s, sink = self.make(url, items)
            s.start()
            first = sink.packets.get(timeout=2)
            self.assertEqual(sink.packets.get(timeout=2)['t'], 'publish')
            self.assertEqual(first['body']['topics']['tone_pending'], 3)
            eventually(lambda:s.last_list is not None and s.last_list['body']['topics']['tone_pending']==0
                       and s.last_list['body']['topics']['list'][0]['count']==5, timeout=5)
            final = deepcopy(s.last_list)
            self.assertEqual(final['body']['topics']['list'][0]['tone'],
                             {'positive':0,'negative':5,'neutral':0,'mixed':0})
            self.assertEqual(kinds, ['topics','topics','tone'])
            titles = [i['title'] for _,_,p in received if 'q_0' in p['questions'] for i in p['state'].values()]
            self.assertEqual(len(titles), 5)
            self.assertFalse(s.tone_in_flight)
            self.assertEqual(first['body']['at'], final['body']['at'])
            self.assertEqual([i['link'] for i in first['body']['items']], [i['link'] for i in final['body']['items']])
            while not sink.packets.empty(): self.assertEqual(sink.packets.get_nowait()['t'], 'msg')
            s.refresh()
            eventually(lambda:s.completed==2)
            self.assertEqual(len(received), 3)  # Both caches hit on refresh.

    def test_tone_failure_no_cache_releases_jobs_and_auth_is_shared(self):
        items, _ = snapshot()
        for status in [500,401,403]:
            with self.subTest(status=status), server(lambda *_:(status,b'',{})) as (url, received):
                s, _ = self.make(url, items)
                s.start()
                eventually(lambda:s.completed==1 and len(received)==1 and not s.tone_in_flight)
                self.assertFalse(s.tone_cache)
                self.assertTrue(s.tone_jobs.empty())
                if status in [401,403]:
                    eventually(lambda:s.last_list['body']['topics']['tone_pending']==0)
                    self.assertTrue(all(not c.enabled for c in [s.classifier,s.analyzer,s.matcher,s.topic_matcher,s.tone_client]))
                s.stop()

    def test_lowest_priority_and_shared_budget(self):
        for budget in [80,100]:
            calls, now = [], [0]
            def client(label, method):
                def request(*args, **kwargs):
                    calls.append(label); now[0]+=20; return {}
                return SimpleNamespace(enabled=True, **{method:request})
            classifier = client('classify','classify')
            classifier.clock=lambda:now[0]; classifier.budget=budget
            s = Scheduler([{'name':'A','url':'unused'}],None,None,1,classifier=classifier,
                analyzer=client('analysis','analyze'), matcher=client('events','match'),
                topic_matcher=client('topics','match'), tone_client=client('tone','tone'))
            work=ModelRound(1)
            s.classify_jobs.put((work,('c','c','')))
            s.classify_cache['a']='finance'
            s.analysis_jobs.put((work,('a','a','')))
            s.event_jobs.put((work,Pair(('l','l',''),('r','r',''),.5)))
            s.topic_jobs.put((work,TopicPair(('seed','seed',''),('t','t',''))))
            s.tone_jobs.put((work,('tone','tone','')))
            results=[]
            def submit(result):
                results.append(result)
                return not all(q.empty() for q in [s.classify_jobs,s.analysis_jobs,s.event_jobs,s.topic_jobs,s.tone_jobs])
            s._submit_classification=submit
            s._classify_worker()
            self.assertEqual(calls,['classify','analysis','events','topics']+(['tone'] if budget==100 else []))
            self.assertIsInstance(results[-1],ToneResult)

    def test_fifo_success_only_active_late_results_and_disabled_counts(self):
        items, _ = snapshot()
        with server() as (url, _):
            s, _ = self.make(url, items)
            s._emit(s.caches,[])
            key=items[0]['link']
            with s.cv:
                s.active=True
                self.assertIsNone(s._accept(ToneResult({key:'mixed','bad':'invalid'},(key,),-99)))
                self.assertNotIn('bad',s.tone_cache)
                for i in range(4000): s._accept(ToneResult({f'old{i}':'neutral'}))
                self.assertEqual(len(s.tone_cache),4000)
                self.assertNotIn(key,s.tone_cache)
                s.active=False
                update=s._accept(ToneResult({key:'mixed'},(key,),-99))
                self.assertEqual(update['body']['topics']['tone_pending'],2)
                self.assertEqual(update['body']['topics']['list'][0]['tone']['mixed'],1)
                s.last_list=update
                self.assertIsNone(s._accept(ToneResult({key:'mixed'})))
                s.classifier.enabled=False
                disabled=s._decorate(s.last_list)
                self.assertEqual(disabled['body']['topics']['tone_pending'],0)
                self.assertEqual(disabled['body']['topics']['list'][0]['tone']['mixed'],1)

    def test_tone_size_reserve_covers_all_counts_and_resend_keeps_items(self):
        items, _ = snapshot()
        with server() as (url, _):
            s, _ = self.make(url,items)
            with s.cv: raw=s._decorate({'t':'msg','seq':1,'body':{'items':items}})
            raw['body']['padding']='x'*(MAX_PACKET-len(packet_bytes(raw))-50)
            first=s._send_list(raw)
            worst=deepcopy(first)
            worst['body']['topics']={'pending':300,'tone_pending':300,'list':[
                {'id':'f'*12,'title':'\U0010ffff'*300,'sources':300,'count':300,
                 'tone':{k:300 for k in ['positive','negative','neutral','mixed']}} for _ in range(5)]}
            for item in worst['body']['items']: item['topic']='f'*12
            self.assertLessEqual(len(packet_bytes(worst)),MAX_PACKET)
            with s.cv:
                update=s._accept(ToneResult({i['link']:'positive' for i in first['body']['items']}))
            second=s._send_list(update)
            self.assertEqual([i['link'] for i in first['body']['items']], [i['link'] for i in second['body']['items']])
            self.assertEqual(second['body']['topics']['tone_pending'],0)
