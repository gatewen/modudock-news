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
    def test_zero_width_words_and_candidates_preserve_zwj(self):
        for separator in '\u200b\u200c\u2060\ufeff':
            with self.subTest(separator=repr(separator)):
                self.assertEqual(words(separator.join('特朗普ALPHA')), words('川普ALPHA'))
                candidate = story('candidate', separator.join('川普訪美 ALPHA'))
                items, groups = snapshot([candidate])
                topics, pending = plan(items, groups, {}, ['A', 'B', 'C'])
                self.assertEqual(len(topics), 1)
                self.assertEqual(pending, [(items[0]['link'], candidate['link'])])
        self.assertEqual(words('AB\u200dCD'), {'AB', 'CD'})

    def test_two_source_event_cannot_seed_even_with_cached_third_source_expansion(self):
        seeds = [story(f's{i}', 'ALPHA', source) for i, source in enumerate('AB')]
        third = story('third', 'ALPHA', 'C')
        items, groups = snapshot([third], seeds)
        seed = seeds[0]['link']
        cache = {(seed, third['link']): True}
        self.assertEqual(plan(items, groups, cache, ['A', 'B', 'C']), ([], []))
        # The cached expansion is viable; only new-seed eligibility prevents it.
        retained, pending = plan(items, groups, cache, ['A', 'B', 'C'], previous=[seed])
        self.assertEqual(retained[0]['sources'], 3)
        self.assertEqual(set(retained[0]['keys']), {item['link'] for item in seeds + [third]})
        self.assertEqual(pending, [])

    def test_pending_limit_keeps_older_high_overlap_ahead_of_newer_single_term_candidates(self):
        seeds = [story(f's{i}', ' '.join(f'TERM{n}' for n in range(10)), source)
                 for i, source in enumerate('ABC')]
        newer = [story(f'candidate{i}', f'TERM{i % 10}', hour=1 + i / 10) for i in range(70)]
        stronger = story('high-overlap', 'TERM0 TERM1', hour=0)
        items, groups = snapshot(newer + [stronger], seeds, size=300)
        topics, pending = plan(items, groups, {}, ['A', 'B', 'C'])
        self.assertEqual(len(topics), 1)
        self.assertEqual(len(pending), 60)
        self.assertEqual(pending, [(seeds[0]['link'], item['link'])
                                   for item in [stronger] + newer[-59:][::-1]])
        self.assertEqual((topics, pending), plan(items[::-1], groups, {}, ['A', 'B', 'C']))

    def test_topic_output_prefers_more_sources_over_more_reports(self):
        broad = [story(f'broad{i}', 'BROAD', source) for i, source in enumerate('ABCD')]
        frequent = [story(f'frequent{i}', 'FREQUENT', source) for i, source in enumerate('ABCABCABC')]
        items, groups = snapshot(seeds=broad + frequent)
        for item in broad:
            groups[item['link']] = {'event': 'broad'}
        for item in frequent:
            groups[item['link']] = {'event': 'frequent'}
        topics, pending = plan(items, groups, {}, ['A', 'B', 'C', 'D'])
        self.assertEqual([(topic['title'], topic['sources'], topic['count']) for topic in topics],
                         [('BROAD', 4, 4), ('FREQUENT', 3, 9)])
        self.assertEqual(pending, [])
        self.assertEqual((topics, pending), plan(items[::-1], groups, {}, ['A', 'B', 'C', 'D']))

    def test_five_previous_topics_do_not_exclude_larger_new_topic_or_leak_pending(self):
        seeds, extras, groups, previous = [], [], {}, []
        for n, size in enumerate([3, 3, 3, 3, 3, 10]):
            for j in range(size):
                item = story(f'event{n}-{j}', f'TERM{n}', chr(65 + j), n)
                seeds.append(item)
                groups[item['link']] = {'event': str(n)}
                if j == 0 and n < 5:
                    previous.append(item['link'])
            extras.append(story(f'candidate{n}', f'TERM{n}'))
        items, padded_groups = snapshot(extras, seeds, size=200)
        padded_groups.update(groups)
        topics, pending = plan(items, padded_groups, {}, list('ABCDEFGHIJ'), previous)
        new_id = sha1(seeds[15]['link'].encode()).hexdigest()[:12]
        old_ids = sorted(sha1(seed.encode()).hexdigest()[:12] for seed in previous)
        self.assertEqual([topic['id'] for topic in topics], [new_id] + old_ids[:4])
        self.assertEqual(topics[0]['sources'], 10)
        selected = {topic['id'] for topic in topics}
        self.assertEqual(len(pending), 5)
        self.assertEqual({sha1(seed.encode()).hexdigest()[:12] for seed, _ in pending}, selected)
        self.assertEqual((topics, pending), plan(items[::-1], padded_groups, {}, list('ABCDEFGHIJ'), previous))

    def test_aliases_chinese_fragments_and_alphanumeric_terms(self):
        self.assertEqual(words('特朗普 特習 ai AB12'), words('川普 川習 AI ab12'))
        terms = words('半導體產業')
        self.assertTrue({'半導', '半導體', '半導體產'} <= terms)
        self.assertNotIn('半導體產業', terms)
        self.assertEqual(words('a 1'), set())

    def test_numeric_tokens_excluded_but_mixed_alphanumeric_kept(self):
        self.assertEqual(words('2026 11 123456 a11 H200 b2b AI'), {'A11','H200','B2B','AI'})
        items, groups = snapshot([story('candidate', '2026')],
                                seeds=[story(f's{i}', '2026 訪美', source) for i, source in enumerate('ABC')])
        self.assertEqual(plan(items, groups, {}, ['A','B','C'])[1], [])

    def test_feature_df_boundary_and_alias_recall(self):
        items, groups = snapshot([story('candidate', '特朗普訪美')], size=40)
        topics, pending = plan(items, groups, {}, ['A', 'B', 'C'])
        self.assertIn((items[0]['link'], items[3]['link']), pending)  # df 4 / 40 = 10%.
        fewer = items[:-1]
        self.assertEqual(plan(fewer, groups, {}, ['A', 'B', 'C'])[1], [])
        self.assertEqual(topics[0]['count'], 3)

    def test_two_layer_snowball_admits_only_direct_reports_and_replans_siblings(self):
        extra = [story('one', 'ALPHA BETA'), story('sibling', 'GAMMA'), story('two', 'BETA DELTA'),
                 story('three', 'DELTA'), story('four', 'GAMMA')]
        items, groups = snapshot(extra)
        groups[extra[1]['link']] = groups[extra[0]['link']]
        seed = items[0]['link']
        cache = {(seed, extra[0]['link']): True, (seed, extra[2]['link']): True}
        original = deepcopy((items, groups, cache))
        topics, pending = plan(items, groups, cache, ['A','B','C'])
        self.assertEqual(topics[0]['count'], 5)
        self.assertEqual(set(pending), {(seed, extra[1]['link']), (seed, extra[3]['link'])})
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
        self.assertIn(sha1(seed.encode()).hexdigest()[:12], [t['id'] for t in topics])
        self.assertEqual([t['id'] for t in topics], sorted(t['id'] for t in topics))
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


class StickyPlanTests(unittest.TestCase):
    def scene(self):
        a = [story(f'sa{i}', 'COMMON ALPHA', source, 3) for i, source in enumerate('ABC')]
        b = [story(f'sb{i}', 'COMMON BETA', source, 1) for i, source in enumerate('ABC')]
        items, groups = snapshot(seeds=a+b)
        for item in a: groups[item['link']] = {'event':'a'}
        for item in b: groups[item['link']] = {'event':'b'}
        return items, groups, a, b

    def test_previous_wins_after_other_event_overtakes_and_keeps_cached_answers(self):
        items, groups, a, b = self.scene()
        seed = a[0]['link']
        cache = {(seed, b[0]['link']):True}
        first, _ = plan(items, groups, cache, ['A','B','C','D','E'])
        for i, source in enumerate('DE'):
            item = story(f'new{i}', 'COMMON BETA', source, 8)
            items.append(item); groups[item['link']] = {'event':'b'}
        sticky, pending = plan(items, groups, cache, ['A','B','C','D','E'], [seed])
        retained = next(t for t in sticky if t['id'] == first[0]['id'])
        self.assertEqual(retained['title'], a[0]['title'])
        self.assertEqual(retained['count'], 8)
        self.assertEqual(pending, [])
        self.assertEqual(len(plan(items, groups, cache, ['A','B','C','D','E'])[0]), 2)

    def test_previous_uses_exact_seed_even_when_not_earliest_and_can_expand_from_two_sources(self):
        items, groups, a, b = self.scene()
        seed = a[1]['link']
        items.remove(a[2])
        cache = {(seed, b[2]['link']):True}
        topics, _ = plan(items, groups, cache, ['A','B','C'], [seed])
        self.assertEqual(len(topics), 1)
        self.assertEqual(topics[0]['id'], sha1(seed.encode()).hexdigest()[:12])
        self.assertEqual(topics[0]['sources'], 3)

    def test_rejected_previous_does_not_claim_events_or_generate_pending(self):
        items, groups, a, b = self.scene()
        # Old seed and its cached expansion still only cover A/B; a new
        # eligible seed must be able to take those reports afterwards.
        items.remove(a[2])
        extra = story('extra', 'COMMON ALPHA', 'B')
        items.append(extra); groups[extra['link']] = {'event':'extra'}
        seed, replacement = a[0]['link'], b[0]['link']
        cache = {(seed, extra['link']):True, (replacement, seed):True,
                 (replacement, extra['link']):True}
        topics, pending = plan(items, groups, cache, ['A','B','C'], [seed, 'missing'])
        self.assertEqual(len(topics), 1)
        self.assertEqual(topics[0]['id'], sha1(replacement.encode()).hexdigest()[:12])
        self.assertEqual(topics[0]['count'], 5)
        self.assertTrue(all(s != seed for s, _ in pending))

    def test_missing_previous_ignored_and_output_sort_independent_of_previous_order(self):
        items, groups, a, b = self.scene()
        aseed, bseed = a[0]['link'], b[0]['link']
        self.assertEqual(plan(items, groups, {}, ['A','B','C']),
                         plan(items, groups, {}, ['A','B','C'], ['missing']))
        extra = story('extra', 'COMMON BETA', 'A')
        items.append(extra); groups[extra['link']] = {'event':'b'}
        first, _ = plan(items, groups, {}, ['A','B','C'], [aseed,bseed])
        second, _ = plan(items[::-1], groups, {}, ['A','B','C'], [bseed,aseed])
        self.assertEqual(first, second)
        self.assertEqual(first[0]['count'], 4)
        self.assertEqual(first[0]['id'], sha1(bseed.encode()).hexdigest()[:12])


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


class PerReportMembershipTests(unittest.TestCase):
    def test_siblings_require_own_answers_even_without_shared_words(self):
        # Three feeds, only two outlets: this remains a per-report event.
        extra=[story('one','ALPHA'),story('brother','完全無關詞','D'),story('sister','別的描述','E')]
        items,groups=snapshot(extra)
        for x in extra: groups[x['link']]={'event':'other'}
        seed=items[0]['link'];cache={(seed,extra[0]['link']):True}
        topics,pending=plan(items,groups,cache,['A','B','C','D','E'],outlets={'E':'D'})
        self.assertEqual(topics[0]['count'],4)
        self.assertEqual(topics[0]['sources'],3)
        self.assertEqual(set(pending),{(seed,x['link']) for x in extra[1:]})
        cache[seed,extra[1]['link']]=False
        cache[seed,extra[2]['link']]=True
        topics,pending=plan(items,groups,cache,['A','B','C','D','E'],[seed],outlets={'E':'D'})
        self.assertEqual(topics[0]['count'],5)
        self.assertEqual(topics[0]['sources'],4)
        self.assertNotIn(extra[1]['link'],topics[0]['keys'])
        self.assertEqual(pending,[])
        # A sticky seed with only two remaining outlets cannot borrow a false sibling.
        items=[x for x in items if x['source'] not in ('C','E')]
        topics,pending=plan(items,groups,cache,['A','B','C','D','E'],[seed],outlets={'E':'D'})
        self.assertEqual((topics,pending),([],[]))

    def test_siblings_precede_general_candidates_within_shared_cap(self):
        siblings=[story(f'x{i}','NOOVERLAP',hour=0) for i in range(65)]
        ordinary=story('general','ALPHA',hour=20)
        trigger=story('trigger','ALPHA')
        items,groups=snapshot([trigger,*siblings,ordinary],size=300)
        for x in [trigger,*siblings]:groups[x['link']]={'event':'other'}
        seed=items[0]['link'];cache={(seed,trigger['link']):True}
        _,pending=plan(items,groups,cache,['A','B','C'])
        self.assertEqual(len(pending),60)
        self.assertTrue(all(k in {x['link'] for x in siblings} for _,k in pending))
        cache.update({pair:False for pair in pending})
        _,pending=plan(items,groups,cache,['A','B','C'])
        self.assertEqual(len(pending),6)
        self.assertEqual(pending[-1],(seed,ordinary['link']))


class ClaimedReportsTests(unittest.TestCase):
    def scene(self, size=3, headlines=False):
        seeds = [story(f's{i}', '川普訪美 ALPHA', src, 5) for i, src in enumerate('ABC')]
        other = [story('x0', 'ALPHA BETA', 'D', 0)]
        other += [story(f'x{i}', 'BETA', src, 0) for i, src in enumerate('EFGH'[:size-1], 1)]
        rest = [story(f'o{n}_{j}', f'主題{n}詞 GAMMA{n}', src, 1)
                for n in range(5) for j, src in enumerate('ABCD')] if headlines else []
        items, groups = snapshot(other+rest, seeds, size=300)
        for item in other: groups[item['link']] = {'event': 'e2'}
        for n in range(5):
            for j in range(4): groups[f'https://example.com/o{n}_{j}'] = {'event': f'o{n}'}
        return items, groups, seeds[0]['link'], [x['link'] for x in other]

    def test_repro37_three_outlet_event_is_admitted_whole(self):
        items, groups, seed, other = self.scene()
        cache = {(seed, other[0]): True, (seed, other[1]): False}
        topics, pending = plan(items, groups, cache, list('ABCDEFGH'), [seed])
        self.assertEqual(len(topics), 1)
        self.assertEqual((topics[0]['sources'], topics[0]['count']), (6, 6))
        self.assertTrue(set(other) <= set(topics[0]['keys']))
        self.assertEqual(pending, [])

    def test_repro37b_five_outlet_headline_is_not_truncated_by_topic_limit(self):
        items, groups, seed, other = self.scene(5, True)
        cache = {(seed, other[0]): True}
        topics, pending = plan(items, groups, cache, list('ABCDEFGHIJ'), [seed])
        self.assertEqual(len(topics), 5)
        self.assertEqual(topics[0]['id'], sha1(seed.encode()).hexdigest()[:12])
        self.assertEqual((topics[0]['sources'], topics[0]['count']), (8, 8))
        self.assertTrue(set(other) <= set(topics[0]['keys']))
        covered = set().union(*(set(t['keys']) for t in topics))
        self.assertEqual(sum(t['count'] for t in topics), len(covered))
        self.assertEqual((topics, pending), plan(items[::-1], groups, cache, list('ABCDEFGHIJ'), [seed]))
        for _ in range(10):
            if not pending: break
            cache.update({pair: False for pair in pending})
            again, pending = plan(items, groups, cache, list('ABCDEFGHIJ'), [seed])
            self.assertEqual(again, topics)
        self.assertEqual(pending, [])

    def test_false_or_unasked_siblings_can_be_candidates_for_another_topic(self):
        items,groups,seed,other=self.scene()
        third=[story(f'z{i}','BETA 專屬新事件',src,2) for i,src in enumerate('GHI')]
        items.extend(third)
        for x in third:groups[x['link']]={'event':'third'}
        second=third[0]['link']
        cache={(seed,other[0]):True,(seed,other[1]):False,(second,other[1]):True}
        topics,pending=plan(items,groups,cache,list('ABCDEFGHI'),[seed,second],outlets={'F':'E'})
        first=next(t for t in topics if t['id']==sha1(seed.encode()).hexdigest()[:12])
        last=next(t for t in topics if t['id']==sha1(second.encode()).hexdigest()[:12])
        self.assertIn(other[0],first['keys'])
        self.assertNotIn(other[1],first['keys'])
        self.assertIn(other[1],last['keys'])
        self.assertIn((second,other[2]),pending)
        self.assertFalse(set(first['keys']) & set(last['keys']))
