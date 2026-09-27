from hashlib import sha1
from copy import deepcopy
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from back.classify import Classifier
from back.analyze import Analyzer
from back.events import EventMatcher, Pair, candidate_pairs
from back.topics import TopicMatcher, TopicPair
from back.scheduler import Scheduler, Cache, TopicResult, AnalysisResult, ModelRound
from back.fetch import Result
from back.feedparse import MAX_PACKET, packet_bytes
from tests.test_classify import server
from tests.test_topics import snapshot, story, response
from tests.test_scheduler import Sink, FunctionFetcher, eventually


class TopicSchedulerTests(unittest.TestCase):
    def setUp(self):
        self.schedulers = []
        self.gates = []

    def tearDown(self):
        for s in self.schedulers: s.stop()
        for gate in self.gates: gate.set()
        for s in self.schedulers:
            for thread in s.workers + [s.coordinator] + s.classify_workers:
                if thread.ident is not None:
                    thread.join(2)
                    self.assertFalse(thread.is_alive())

    def make(self, url, items, *, cache_events=True, **options):
        client = Classifier(endpoint=url, key='topics-test-secret', log=lambda _: None, **options)
        sink = Sink()
        names = list(dict.fromkeys(i['source'] for i in items))
        s = Scheduler([{'name':n,'url':'unused'} for n in names], FunctionFetcher(lambda *_:Result('not_modified')),
            sink, 1, classifier=client, analyzer=Analyzer(shared=client), matcher=EventMatcher(shared=client),
            topic_matcher=TopicMatcher(shared=client), log=lambda _:None)
        s.caches = [Cache([deepcopy(i) for i in items if i['source']==n], available=True) for n in names]
        s.classify_cache.update({i['link']:'society' for i in items})
        if cache_events:
            s.event_cache.update({p.key:False for p in candidate_pairs(items) if not p.automatic})
        self.schedulers.append(s)
        return s, sink

    def done(self, s):
        with s.cv:
            return s.completed == 1 and not (s.in_flight or s.analysis_in_flight or s.event_in_flight or s.topic_in_flight)

    def test_event_gate_snowball_resends_same_at_no_publish_and_no_duplicate_work(self):
        extra = [story('one','ALPHA ALPHAX BETA BETAX'), story('two','BETA BETAX DELTA DELTAX'), story('three','DELTA DELTAX EPSILON')]
        items, _ = snapshot(extra)
        gate, entered = threading.Event(), threading.Event()
        self.gates.append(gate)
        kinds = []
        def respond(p, *_):
            if 'same_0' in p['questions']:
                kinds.append('events')
                entered.set(); gate.wait(2)
                return 200, {'answers':{q:{'choice':'different','probabilities':{'different':.9}} for q in p['questions']}}, {}
            kinds.append('topics')
            return response(p)
        with server(respond) as (url, received):
            s, sink = self.make(url, items, cache_events=False)
            # Leave one genuine event question pending; synthetic padding has
            # many similar pairs and is not testing the event queue capacity.
            pairs = [p for p in candidate_pairs(items) if not p.automatic]
            s.event_cache.update({p.key: False for p in pairs[1:]})
            s.start()
            first = sink.packets.get(timeout=2)
            self.assertEqual(sink.packets.get(timeout=2)['t'], 'publish')
            self.assertTrue(entered.wait(2))
            with s.cv:
                self.assertGreater(s.last_list['body']['events']['pending'], 0)
                self.assertEqual(s.last_list['body']['topics']['list'], [])
                self.assertEqual(s.last_list['body']['topics']['pending'], 0)
                self.assertTrue(all('topic' not in item for item in s.last_list['body']['items']))
                self.assertTrue(s.topic_jobs.empty())
                self.assertFalse(s.topic_in_flight)
            gate.set()
            eventually(lambda:self.done(s), timeout=5)
            # Cache acceptance releases in-flight before the coordinator sends
            # the fitted packet; wait for the observable final list as well.
            eventually(lambda:s.last_list['body']['topics']['pending'] == 0, timeout=2)
            with s.cv: final = deepcopy(s.last_list)
            self.assertEqual(final['body']['topics']['pending'], 0)
            self.assertEqual(final['body']['topics']['list'][0]['count'], 6)
            self.assertEqual(sum('topic' in i for i in final['body']['items']), 6)
            self.assertEqual(final['body']['at'], first['body']['at'])
            self.assertEqual(len(final['body']['items']), len(first['body']['items']))
            self.assertEqual(kinds, sorted(kinds, key=lambda k:k=='topics'))
            pairs = [(p['state']['news_0']['title'], v['title']) for _,_,p in received if 't_1' in p['questions']
                     for k,v in p['state'].items() if k!='news_0']
            self.assertEqual(len(pairs), len(set(pairs)))
            self.assertEqual(len([k for k in kinds if k=='topics']), 3)
            while not sink.packets.empty(): self.assertEqual(sink.packets.get_nowait()['t'], 'msg')

    def test_false_result_clears_pending_failure_does_not_cache_and_auth_disables_all(self):
        items, _ = snapshot([story('one','ALPHA ALPHAX REACTION')])
        for status in [200, 500, 401, 403]:
            with self.subTest(status=status), server(lambda p,*_: (status, {'answers':{
                q:{'choice':'different','probabilities':{'different':.9}} for q in p['questions']}}, {})) as (url, received):
                s, sink = self.make(url, items)
                s.start()
                first = sink.packets.get(timeout=2)
                sink.packets.get(timeout=2)
                eventually(lambda:self.done(s))
                self.assertEqual(len(received), 2 if status == 500 else 1)
                self.assertFalse(s.topic_in_flight)
                if status in [200,401]:
                    eventually(lambda:s.last_list['body']['topics']['pending'] == 0)
                if status == 200:
                    self.assertEqual(list(s.topic_cache.values()), [False])
                    self.assertEqual(s.last_list['body']['topics']['pending'], 0)
                    self.assertEqual(s.last_list['body']['topics']['list'], first['body']['topics']['list'])
                else:
                    self.assertFalse(s.topic_cache)
                if status == 401:
                    self.assertTrue(all(not c.enabled for c in [s.classifier,s.analyzer,s.matcher,s.topic_matcher]))
                    self.assertEqual(s.last_list['body']['topics']['pending'], 0)
                s.stop()

    def test_priority_and_shared_budget(self):
        for budget in [60, 100]:
            calls, now = [], [0]
            def request(label):
                def run(*args, **kwargs):
                    calls.append(label); now[0] += 20; return {}
                return run
            s = Scheduler([{'name':'A','url':'unused'}], None, None, 1,
                classifier=SimpleNamespace(enabled=True, clock=lambda:now[0], budget=budget, classify=request('classify')),
                analyzer=SimpleNamespace(enabled=True, analyze=request('analysis')),
                matcher=SimpleNamespace(enabled=True, match=request('events')),
                topic_matcher=SimpleNamespace(enabled=True, match=request('topics')))
            # This unit isolates lane ordering, not topic eligibility.
            s._topic_admission = lambda: {'seed': {'topic'}}
            work = ModelRound(1)
            s.topic_jobs.put((work, TopicPair(('seed','seed',''),('topic','topic',''))))
            s.event_jobs.put((work, Pair(('left','left',''),('right','right',''), .5)))
            s.classify_cache['analysis'] = 'finance'
            s.analysis_jobs.put((work, ('analysis','analysis','')))
            s.classify_jobs.put((work, ('classify','classify','')))
            results = []
            def submit(result):
                results.append(result)
                return not all(q.empty() for q in [s.topic_jobs,s.event_jobs,s.analysis_jobs,s.classify_jobs])
            s._submit_classification = submit
            s._classify_worker()
            # The 20s event batch triggers the zero-classification rescue.
            self.assertEqual(calls, ['events','classify','topics'] + (['analysis'] if budget==100 else []))
            self.assertIsInstance(results[-1], AnalysisResult)
            if budget==60: self.assertTrue(work.failed)

    def test_topic_cache_fifo_late_results_active_suppression_and_no_change_no_resend(self):
        items, _ = snapshot([story('one','ALPHA ALPHAX REACTION')])
        with server(response) as (url, _):
            s, _ = self.make(url, items)
            packet = s._emit(s.caches, [{'name':f['name'],'count':0} for f in s.feeds])
            seed = min((i for i in items if i['link'].endswith('s0')), key=lambda i:i['link'])['link']
            key = (seed, 'https://example.com/one')
            with s.cv:
                s.active = True
                self.assertIsNone(s._accept(TopicResult({key:True}, (key,), -99)))
                self.assertTrue(s.topic_cache[key])
                s.active = False
                changed = s._decorate(packet)
                s.last_list = changed
                self.assertIsNone(s._accept(TopicResult({key:True}, (key,), -99)))
                s.active = True
                for n in range(20000): s._accept(TopicResult({('unused',str(n)):False}))
                self.assertEqual(len(s.topic_cache), 20000)
                self.assertNotIn(key, s.topic_cache)
                self.assertEqual(next(iter(s.topic_cache)), ('unused','0'))

    def test_disabled_keeps_known_topic_members_and_zero_pending(self):
        items, _ = snapshot([story('one','ALPHA ALPHAX REACTION')])
        with server(response) as (url, received):
            s, _ = self.make(url, items)
            s.topic_cache[items[0]['link'], items[3]['link']] = True
            s.classifier.enabled = False
            packet = s._emit(s.caches, [])
            self.assertEqual(packet['body']['topics']['pending'], 0)
            self.assertEqual(packet['body']['topics']['list'][0]['count'], 4)
            self.assertEqual(received, [])

    def test_size_reserves_topics_before_first_emit_and_resend_keeps_links(self):
        items, _ = snapshot([story('one','ALPHA ALPHAX REACTION')])
        with server(response) as (url, _):
            s, _ = self.make(url, items)
            with s.cv:
                raw = s._decorate({'t':'msg','seq':1,'body':{'items':items,'at':'2026-09-25'}})
            raw['body']['padding'] = 'x' * (MAX_PACKET - len(packet_bytes(raw)) - 50)
            self.assertLessEqual(len(packet_bytes(raw)), MAX_PACKET)
            first = s._send_list(raw)
            self.assertLess(len(first['body']['items']), len(items))
            before = [i['link'] for i in first['body']['items']]
            worst = deepcopy(first)
            for item in worst['body']['items']: item['topic'] = 'f' * 12
            worst['body']['topics'] = {'pending':300, 'list':[
                {'id':'f'*12, 'title':'\U0010ffff'*300, 'sources':300, 'count':300} for _ in range(5)]}
            self.assertLessEqual(len(packet_bytes(worst)), MAX_PACKET)
            s.topic_cache[items[0]['link'], items[3]['link']] = True
            with s.cv: update = s._decorate(first)
            second = s._send_list(update)
            self.assertEqual([i['link'] for i in second['body']['items']], before)
            self.assertLessEqual(len(packet_bytes(second)), MAX_PACKET)

    @patch("back.scheduler.MODEL_WORKERS", 1)  # Serial regression; parallel admission covered in test_model_workers.
    def test_topic_failure_releases_remaining_batches_and_next_round_can_retry(self):
        title = ' '.join(f'TERM{i} EXTRA{i}' for i in range(10))
        seeds = [story(f's{i}', title, source) for i,source in enumerate('ABC')]
        extra = [story(f'x{i}', f'TERM{i%10} REACTION{i}') for i in range(50)]
        items, _ = snapshot(extra, seeds, 300)
        with server(lambda *_:(500,b'',{})) as (url, received):
            s, _ = self.make(url, items)
            s.start()
            eventually(lambda:self.done(s), timeout=5)
            self.assertEqual(len(received), 4)  # Three originals, one retry; other retries are released.
            self.assertFalse(s.model_requeues)
            self.assertTrue(s.topic_jobs.empty())
            self.assertFalse(s.topic_in_flight)
            self.assertFalse(s.topic_cache)
            s.refresh()
            eventually(lambda:s.completed==2 and not s.topic_in_flight and len(received)==8, timeout=5)
            self.assertFalse(s.topic_cache)

    def test_newcomers_keep_construction_order_even_after_final_logged_send(self):
        items = [story(k, title, src) for k, title, src in [
            ('c1', '跨海峰會甲', 'A'), ('c2', '跨海峰會乙', 'B'), ('c3', '跨海峰會丙', 'C'),
            ('d1', '颱風災情甲', 'A'), ('d2', '颱風災情乙', 'B'), ('d3', '颱風災情丙', 'C'),
            ('k', '共用候選報導', 'A'), ('x1', '颱風後續一', 'B'), ('x2', '颱風後續二', 'C')]]
        items, _ = snapshot(items, seeds=[], size=49)
        key = lambda k: 'https://example.com/' + k
        groups = {i['link']: dict(event=i['link'], event_size=1) for i in items}
        for prefix, event in [('c', 'A_c'), ('d', 'B_d')]:
            for i in range(1, 4):
                groups[key(prefix+str(i))] = dict(event=event, event_size=3)
        s, _ = self.make('http://unused', items)
        for seed in ('c1', 'd1'):
            s.topic_cache.update({(key(seed), i['link']): False for i in items})
        s.topic_cache.update({(key(a), key(b)): True for a,b in
                              [('c1','k'), ('d1','k'), ('d1','x1'), ('d1','x2')]})
        with patch('back.scheduler.group_events', return_value=groups):
            sent = s._emit(s.caches, [])
            self.assertEqual([t['count'] for t in sent['body']['topics']['list']], [5, 4])
            self.assertEqual(s.last_topic_seeds, (key('c1'), key('d1')))
            s.model_work.logged = True
            s.last_topic_seeds = ()  # Newcomers are committed only by the final send.
            # Even a final resend after logging must not change ownership or
            # introduce unanswered pairs on the next plan.
            for _ in range(2):
                fresh = s._decorate(s.last_list)
                self.assertEqual(fresh['body']['topics'], sent['body']['topics'])
                self.assertEqual([i.get('topic') for i in fresh['body']['items']],
                                 [i.get('topic') for i in sent['body']['items']])
                s._send_list(fresh)
            self.assertEqual(s.model_work.http, 0)

    def test_sent_topic_ranking_does_not_reorder_sticky_seeds(self):
        items, _ = snapshot(size=60)
        s, _ = self.make('http://unused', items)
        packet = s._emit(s.caches, [])
        a, b, c = [i['link'] for i in items[:3]]
        s.last_topic_seeds = (b, a, 'removed')
        packet['body']['topics']['list'] = [dict(id=sha1(k.encode()).hexdigest()[:12]) for k in (a, b, c)]
        with patch.object(s, '_decorate_events', side_effect=lambda p, **kw:(p, (b, a, c))):
            s._send_list(packet, fitted=True)
        self.assertEqual(s.last_topic_seeds, (b, a, c))

    def test_idle_topic_refill_uses_current_plan_and_preserves_admission_guards(self):
        items, _ = snapshot([story('extra', 'ALPHA ALPHAX unrelated report followup', 'D')])
        s, _ = self.make('http://unused', items)
        s._emit(s.caches, [])
        with s.cv:
            with s.topic_jobs.mutex:
                s.topic_jobs.queue.clear()
            s.topic_in_flight.clear()
            for blocked in ('active', 'failed', 'deadline', 'logged'):
                with self.subTest(blocked=blocked):
                    target, attr, value = ((s, 'active', True) if blocked == 'active' else
                        (s.model_work, 'failed', True) if blocked == 'failed' else
                        (s.model_work, 'deadline', s.model_clock()-1) if blocked == 'deadline' else
                        (s.model_work, 'logged', True))
                    with patch.object(target, attr, value):
                        s._refill_idle_topics()
                    self.assertTrue(s.topic_jobs.empty())
            s._refill_idle_topics()
            self.assertEqual(s.topic_jobs.qsize(), 1)
            self.assertEqual(len(s.topic_in_flight), 1)
            s._refill_idle_topics()
            self.assertEqual(s.topic_jobs.qsize(), 1)

    def test_coordinator_refills_orphan_topic_before_logging_round(self):
        items, _ = snapshot([story('extra', 'ALPHA ALPHAX unrelated report followup', 'D')])
        s, _ = self.make('http://unused', items)
        s._emit(s.caches, [])
        with s.cv:
            with s.topic_jobs.mutex:
                s.topic_jobs.queue.clear()
            s.topic_in_flight.clear()
            s.pending_refresh = False
            s.next_round = s.clock() + 600
        # Run only the coordinator: no future result or refresh can rescue it.
        s.coordinator.start()
        eventually(lambda: s.topic_jobs.qsize() == 1)
        with s.cv:
            self.assertFalse(s.model_work.logged)
            self.assertEqual(len(s.topic_in_flight), 1)

    def test_seed_state_tracks_only_successfully_sent_lists_and_survives_round_stop(self):
        # Keep the older replacement seed visible under the per-source ceiling.
        items, _ = snapshot(size=60)
        with server(response) as (url, _):
            s, sink = self.make(url, items)
            first = s._emit(s.caches, [])
            previous = s.last_topic_seeds
            self.assertEqual(previous, (items[0]['link'],))
            older = story('older', items[0]['title'], 'A', -2)
            s.caches[0].items.append(older)
            second = s._emit(s.caches, [])
            self.assertEqual(second['body']['topics']['list'][0]['id'], first['body']['topics']['list'][0]['id'])
            self.assertEqual(s.last_topic_seeds, previous)
            s.caches[0].items = [i for i in s.caches[0].items if i['link'] != previous[0]]
            original_put = sink.put
            sink.put = lambda _:False
            self.assertIsNone(s._emit(s.caches, []))
            self.assertEqual(s.last_topic_seeds, previous)
            self.assertEqual(s.last_list, second)
            sink.put = original_put
            s._emit(s.caches, [])
            self.assertEqual(s.last_topic_seeds, (older['link'],))
            with s.cv:
                s._begin()
            self.assertEqual(s.last_topic_seeds, (older['link'],))
            s.stop()
            self.assertEqual(s.last_topic_seeds, (older['link'],))

    def test_pending_events_retain_only_previous_members_and_recount_sources_tone(self):
        old_member=story('one','ALPHA ALPHAX BETA BETAX','D')
        items, groups=snapshot([old_member])
        with server(response) as (url, _):
            s, _=self.make(url,items)
            s.topic_cache[items[0]['link'],old_member['link']]=True
            s.tone_cache.update({items[0]['link']:'positive',items[1]['link']:'negative',
                                 items[2]['link']:'negative',old_member['link']:'neutral'})
            first=s._emit(s.caches,[])
            old=first['body']['topics']['list'][0]
            self.assertEqual((old['sources'],old['count']),(4,4))
            added=[story(f'new{i}','全新話題 OMEGA',source) for i,source in enumerate('DEF')]
            current=[i for i in items if i['link']!=items[2]['link']]+added
            groups.update({i['link']:{'event':'new-event'} for i in added})
            with s.cv:
                packet=s._decorate_topics({'body':{'items':deepcopy(current),'events':{'pending':3}}},groups)
            self.assertEqual(packet['body']['topics']['pending'],0)
            kept=packet['body']['topics']['list']
            self.assertEqual(len(kept),1)
            self.assertEqual((kept[0]['id'],kept[0]['title']),(old['id'],old['title']))
            self.assertEqual((kept[0]['sources'],kept[0]['count']),(3,3))
            self.assertEqual(kept[0]['tone'],{'positive':1,'negative':1,'neutral':1,'mixed':0})
            self.assertTrue(all('topic' not in i for i in packet['body']['items'] if i['link'].split('/')[-1].startswith('new')))
            s.last_list=deepcopy(packet)
            with s.cv:
                packet['body']['events']['pending']=0
                settled=s._decorate_topics(packet,groups)
            self.assertIn('全新話題 OMEGA',[t['title'] for t in settled['body']['topics']['list']])

    def test_pending_events_drop_topic_below_three_surviving_sources(self):
        items, groups=snapshot()
        with server(response) as (url, _):
            s, _=self.make(url,items)
            s._emit(s.caches,[])
            self.assertEqual(len(s.last_list['body']['topics']['list']),1)
            remaining=[i for i in s.last_list['body']['items'] if i['source']!='C']
            with s.cv:
                packet=s._decorate_topics({'body':{'items':remaining,'events':{'pending':1}}},groups)
            self.assertEqual(packet['body']['topics']['list'],[])
            self.assertEqual(packet['body']['topics']['pending'],0)
            self.assertTrue(all('topic' not in i for i in packet['body']['items']))
