"""Topic admission must use live ownership without weakening lane accounting."""
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from back.scheduler import Scheduler, ModelRound
from back.topics import TopicPair, plan
from tests.test_topics import snapshot, story


class TopicAdmissionTests(unittest.TestCase):
    def make(self, items, groups):
        client = SimpleNamespace(enabled=True, clock=lambda: 0, budget=60,
                                 classify=lambda b: {}, match=lambda b: self.fail('unexpected HTTP'))
        s = Scheduler([{'name': n, 'url': 'unused'} for n in 'ABCD'], None, None, 1,
                      classifier=client, topic_matcher=client, log=lambda _: None)
        s.last_list = {'body': {'items': items}}
        return s

    def test_all_built_seeds_and_candidates_not_only_five_or_sixty(self):
        seeds, groups = [], {}
        for n in range(11):
            for j, source in enumerate('ABC'):
                i = story(f'e{n}-{j}', f'TERM{n} EXTRA{n}', source, n)
                seeds.append(i); groups[i['link']] = {'event': str(n)}
        extras = [story(f'x{n}-{j}', f'TERM{n} EXTRA{n}') for n in range(11) for j in range(65)]
        for i in extras: groups[i['link']] = {'event': i['link']}
        items = seeds + extras
        previous = tuple(seeds[n*3]['link'] for n in range(11))
        eligible = plan(items, groups, {}, list('ABC'), previous, admission=True)
        self.assertEqual(set(eligible), set(previous[:10]))
        self.assertEqual(len(eligible[previous[0]]), 65)
        self.assertNotIn(previous[10], eligible)

    def test_live_cache_whole_event_claims_and_interleaved_packing(self):
        extras = [story(f'x{i}', 'ALPHA ALPHAX EXTENSION') for i in range(24)]
        items, groups = snapshot(extras, size=400)
        s = self.make(items, groups); work = ModelRound(1)
        seed = items[0]['link']; row = lambda i: (i['link'], i['title'], i['summary'])
        pairs = [TopicPair(row(items[0]), row(i)) for i in extras]
        # One true takes both reports in another seed-qualified event.
        group = [story(f'g{i}', 'OTHER ALPHA ALPHAX', source) for i, source in enumerate('BCD')]
        items.extend(group)
        for i in group: groups[i['link']] = {'event': 'whole'}
        s.topic_cache[seed, group[0]['link']] = True
        s.topic_cache[pairs[0].key] = False
        stale = TopicPair(row(items[0]), row(group[1]))
        other = TopicPair(('gone','gone',''), row(extras[-1]))
        lane = next(l for l in s.lanes if l.name == 'topics')
        queued = [pairs[0], stale, other, *pairs[1:]]
        for p in queued:
            s.topic_jobs.put((work, p)); s.topic_in_flight.add(p.key)
        with patch('back.scheduler.group_events', return_value=groups), s.cv:
            _, first = s.topic_jobs.get_nowait()
            batch, _ = s._take_batch(lane, work, first)
            self.assertEqual([p.key for p in batch], [p.key for p in pairs[1:20]])
            self.assertEqual(s.topic_jobs.qsize(), 4)
            self.assertEqual(len(s.results), 1)
            dropped = s.results.popleft()
            self.assertEqual(set(dropped.finished), {pairs[0].key, stale.key, other.key})
            s.active = True
            s._accept(dropped)
            self.assertFalse(set(dropped.finished) & s.topic_in_flight)
            self.assertEqual(work.requests['topics'], 0)
            self.assertEqual(work.awaiting, 0)

    def test_same_seed_across_other_valid_seed_and_round_boundary(self):
        items, groups = snapshot(); s = self.make(items, groups)
        s._topic_admission = lambda: {'a': {'x','y'}, 'b': {'z'}}
        pair = lambda a,b: TopicPair((a,a,''),(b,b,''))
        w, later = ModelRound(1), ModelRound(2)
        a, b, c = pair('a','x'), pair('b','z'), pair('a','y')
        s.topic_jobs.put((w,b)); s.topic_jobs.put((w,c)); s.topic_jobs.put((later,c))
        lane = next(l for l in s.lanes if l.name=='topics')
        with s.cv:
            batch,_=s._take_batch(lane,w,a)
        self.assertEqual(batch,[a,c])
        self.assertEqual(list(s.topic_jobs.queue),[(w,b),(later,c)])

    def test_empty_batch_completes_without_http_failure_or_stats(self):
        items, groups = snapshot(); s = self.make(items, groups)
        pair=TopicPair(('gone','gone',''),('x','x','')); w=ModelRound(1)
        s.topic_jobs.put((w,pair)); s.topic_in_flight.add(pair.key)
        def submit(result):
            s.active=True
            s._accept(result)
            s.stopping=True
            return True
        s._submit_classification=submit
        with patch('back.scheduler.group_events',return_value=groups):s._classify_worker()
        self.assertFalse(s.topic_in_flight)
        self.assertEqual(sum(w.requests.values()),0)
        self.assertFalse(w.failed)
        self.assertEqual(w.awaiting,0)
        self.assertFalse(s.model_rounds)

    def test_admission_rebuilds_groups_from_latest_event_cache(self):
        seeds = [story(f's{i}', 'ALPHA ALPHAX ' + word, source)
                 for i, (word, source) in enumerate(zip(('ONE','TWO','THREE'), 'ABC'))]
        extra = story('extra', 'ALPHA ALPHAX REACTION')
        items, groups = snapshot([extra], seeds=seeds)
        s = self.make(items, groups)
        # Display fields deliberately lag acceptance; only current cache may merge.
        for item in items: item['event'] = item['link']
        self.assertEqual(s._topic_admission(), {})
        seed = seeds[0]['link']
        for item in seeds[1:]: s.event_cache[frozenset((seed,item['link']))] = True
        self.assertIn(extra['link'], s._topic_admission()[seed])
        s.topic_cache[seed,extra['link']] = False
        self.assertNotIn(extra['link'], s._topic_admission()[seed])
        s.topic_cache[seed,extra['link']] = True
        self.assertNotIn(extra['link'], s._topic_admission()[seed])

    def test_empty_completion_keeps_started_round_open_until_accepted(self):
        items, groups = snapshot()
        for retry in (False, True):
            with self.subTest(retry=retry):
                s = self.make(items, groups)
                logs = []; s.log = logs.append
                w = ModelRound(7, started=0)
                w.requests['classify'] = 1
                s.model_rounds[7] = w
                pair = TopicPair(('gone', 'gone', ''), ('x', 'x', ''))
                s.topic_in_flight.add(pair.key)
                lane = next(l for l in s.lanes if l.name == 'topics')
                with patch('back.scheduler.group_events', return_value=groups), s.cv:
                    if retry:
                        # The retry path must use the same empty-completion accounting.
                        batch = s._prune_topic_batch(w, [pair], {})
                    else:
                        batch, _ = s._take_batch(lane, w, pair)
                    self.assertEqual(batch, [])
                    s._finish_model_rounds()
                    self.assertFalse(w.logged)
                    self.assertEqual(logs, [])
                    result = s.results.popleft()
                    self.assertEqual(result.round_id, 7)
                    self.assertTrue(result.accounted)
                    self.assertEqual(w.awaiting, 1)
                    s.active = True
                    s._accept(result)
                    self.assertEqual(w.awaiting, 0)
                    self.assertFalse(s.topic_in_flight)
                    s._finish_model_rounds()
                self.assertTrue(w.logged)
                self.assertEqual(len(logs), 1)
                self.assertIn('requests=1', logs[0])
                self.assertIn('topics=0', logs[0])
                self.assertIn('http=0', logs[0])
