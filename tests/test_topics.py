from copy import deepcopy
from datetime import datetime, timedelta, timezone
from hashlib import sha1
import unittest

from back.topics import plan, words, TopicMatcher, TopicPair, CRITERIA
from back.feedparse import dedup_key
from tests.test_classify import server


def story(key, title, source='A', hour=0):
    return dict(link=f'https://example.com/{key}', title=title, summary='', source=source,
                published=(datetime(2026, 9, 25, tzinfo=timezone.utc) + timedelta(hours=hour)).isoformat())


def snapshot(extra=(), seeds=None, size=100):
    items = seeds if seeds is not None else [story(f's{i}', '川普訪美 ALPHA', source, i) for i, source in enumerate('ABC')]
    items = items + list(extra)
    groups = {dedup_key(i['link']): {'event': 'seed' if i['link'].split('/')[-1].startswith('s') else i['link']} for i in items}
    for i in range(size - len(items)):
        item = story(f'pad{i}', f'獨立填充 Z{i:04d}')
        items.append(item)
        groups[item['link']] = {'event': item['link']}
    return items, groups


def response(payload, *_):
    return 200, {'answers': {name: {'choice': 'same_topic', 'probabilities': {'same_topic': .9}}
                             for name in payload['questions']}}, {}


class PlanTests(unittest.TestCase):
    def test_aliases_chinese_fragments_and_alphanumeric_terms(self):
        self.assertEqual(words('特朗普 特習 ai AB12'), words('川普 川習 AI ab12'))
        terms = words('半導體產業')
        self.assertTrue({'半導', '半導體', '半導體產'} <= terms)
        self.assertNotIn('半導體產業', terms)
        self.assertEqual(words('a 1'), set())

    def test_feature_df_boundary_and_alias_recall(self):
        items, groups = snapshot([story('candidate', '特朗普訪美')], size=40)
        topics, pending = plan(items, groups, {}, ['A', 'B', 'C'])
        self.assertIn((items[0]['link'], items[3]['link']), pending)  # df 4 / 40 = 10%.
        fewer = items[:-1]
        self.assertEqual(plan(fewer, groups, {}, ['A', 'B', 'C'])[1], [])
        self.assertEqual(topics[0]['count'], 3)

    def test_two_layer_snowball_merges_whole_event_and_replans_unknowns(self):
        extra = [story('one', 'ALPHA BETA'), story('sibling', 'GAMMA'), story('two', 'BETA DELTA'),
                 story('three', 'DELTA'), story('four', 'GAMMA')]
        items, groups = snapshot(extra)
        groups[extra[1]['link']] = groups[extra[0]['link']]
        seed = items[0]['link']
        cache = {(seed, extra[0]['link']): True, (seed, extra[2]['link']): True}
        original = deepcopy((items, groups, cache))
        topics, pending = plan(items, groups, cache, ['A','B','C'])
        self.assertEqual(topics[0]['count'], 6)
        self.assertEqual(set(pending), {(seed, extra[3]['link']), (seed, extra[4]['link'])})
        self.assertEqual((items, groups, cache), original)
        self.assertEqual((topics, pending), plan(items[::-1], dict(reversed(list(groups.items()))), cache, ['A','B','C']))
        cache[seed, extra[3]['link']] = False
        self.assertNotIn((seed, extra[3]['link']), plan(items, groups, cache, ['A','B','C'])[1])

    def test_window_anchored_to_seed_latest_includes_48_hours(self):
        extra = [story('left', 'ALPHA', hour=-46), story('right', 'ALPHA', hour=50),
                 story('before', 'ALPHA', hour=-46.001), story('after', 'ALPHA', hour=50.001)]
        items, groups = snapshot(extra)
        pending = plan(items, groups, {}, ['A','B','C'])[1]
        self.assertEqual({key for _, key in pending}, {extra[0]['link'], extra[1]['link']})

    def test_taken_seed_is_skipped_max_five_and_feed_order_breaks_rep_ties(self):
        seeds = [story(f's{n}-{i}', f'TOKEN{n} COMMON', source) for n in range(7) for i, source in enumerate('ABC')]
        items, groups = snapshot(seeds=seeds, size=300)
        for n in range(7):
            for i in range(3): groups[seeds[n * 3 + i]['link']] = {'event': f'{n:012d}'}
        topics, _ = plan(items, groups, {}, ['C','B','A'])
        self.assertEqual(len(topics), 5)
        seed = seeds[2]['link']
        self.assertEqual(topics[0]['id'], sha1(seed.encode()).hexdigest()[:12])
        merged, _ = plan(items, groups, {(seed, seeds[3]['link']): True}, ['C','B','A'])
        self.assertEqual(merged[0]['count'], 6)
        self.assertFalse(set(merged[0]['keys']) & set(merged[1]['keys']))
        self.assertNotIn(sha1(seeds[5]['link'].encode()).hexdigest()[:12], [t['id'] for t in merged])

    def test_pending_cap_60_rank_by_overlap_then_newest_and_seed_order(self):
        title = ' '.join(f'TERM{i}' for i in range(10))
        seeds = [story(f's{i}', title, source) for i, source in enumerate('ABC')]
        extra = [story(f'x{i}', f'TERM{i % 10}', hour=i / 10) for i in range(70)]
        items, groups = snapshot(extra, seeds, 300)
        pending = plan(items, groups, {}, ['A','B','C'])[1]
        self.assertEqual(len(pending), 60)
        self.assertEqual([key for _, key in pending], [i['link'] for i in extra[:9:-1]])
        cache = {pair: False for pair in pending}
        self.assertEqual(len(plan(items, groups, cache, ['A','B','C'])[1]), 10)

    def test_seed_rank_prefers_source_count_then_latest_report(self):
        seeds = [story(f's{event}-{i}', f'TOPIC{event}', source, hour)
                 for event, names, hour in [('a', 'ABCD', 0), ('b', 'ABC', 4), ('c', 'ABC', 8)]
                 for i, source in enumerate(names)]
        items, groups = snapshot(seeds=seeds)
        for item in seeds:
            groups[item['link']] = {'event': item['link'].split('/')[-1][1]}
        expected = plan(items, groups, {}, ['A','B','C','D'])
        self.assertEqual([t['title'] for t in expected[0]], ['TOPICa','TOPICc','TOPICb'])
        self.assertEqual(expected, plan(items[::-1], groups, {}, ['A','B','C','D']))


class TopicMatcherTests(unittest.TestCase):
    def pairs(self, count=2, title='候選'):
        return [TopicPair(('seed', '種子', '摘要'), (f'key{i}', title, '')) for i in range(count)]

    def test_exact_questions_state_shape_and_directional_results(self):
        with server(response) as (url, received):
            client = TopicMatcher(endpoint=url, key='test', log=lambda _: None)
            self.assertEqual(client.match(self.pairs()), {('seed','key0'): True, ('seed','key1'): True})
        payload = received[0][2]
        self.assertEqual(set(payload['state']), {'news_0','news_1','news_2'})
        self.assertEqual(payload['state']['news_0'], {'title':'種子','summary':'摘要'})
        for i in [1, 2]:
            self.assertEqual(payload['questions'][f't_{i}'], {'type':'choice', 'criteria':CRITERIA,
                'instructions':f'news_0 是一個大新聞話題的代表報導。news_{i} 和 news_0 是否屬於同一個新聞話題？'})
        self.assertEqual(CRITERIA, {'same_topic':'同一個話題：同一件大事的報導、後續發展、各方反應、評論或影響',
                                  'different':'不同話題：即使人物或領域相同，講的是另一件事'})

    def test_threshold_different_and_invalid_second_answer_rejects_entire_batch(self):
        for choice, p, expected in [('same_topic', .69, False), ('same_topic', .7, True), ('different', .99, False)]:
            with self.subTest(choice=choice, p=p), server(lambda *_: (200, {'answers': {
                't_1': {'choice':choice, 'probabilities':{choice:p}}}}, {})) as (url, _):
                self.assertEqual(TopicMatcher(endpoint=url, key='test').match(self.pairs(1)), {('seed','key0'):expected})
        with server(lambda *_: (200, {'answers': {'t_1': {'choice':'same_topic','probabilities':{'same_topic':.9}}, 't_2':{}}}, {})) as (url, _):
            self.assertIsNone(TopicMatcher(endpoint=url, key='test', log=lambda _:None).match(self.pairs()))

    def test_batches_respect_state_chars_seed_and_failure_stops_round(self):
        with server(response) as (url, received):
            client = TopicMatcher(endpoint=url, key='test')
            self.assertEqual([len(r) for r in client.match_round(self.pairs(40))], [19,19,2])
            received.clear()
            self.assertEqual([len(r) for r in client.match_round(self.pairs(3, 'x'*3998))], [2,1])
            self.assertTrue(all(sum(len(i['title'])+len(i['summary']) for i in p['state'].values()) <= 8000 for _,_,p in received))
            other = TopicPair(('other','其他',''), ('key','標題',''))
            self.assertEqual([len(r) for r in client.match_round(self.pairs(1)+[other])], [1,1])
        with server(lambda *_: (500, b'', {})) as (url, received):
            self.assertEqual(list(TopicMatcher(endpoint=url, key='test', log=lambda _:None).match_round(self.pairs(40))), [])
            self.assertEqual(len(received), 1)
