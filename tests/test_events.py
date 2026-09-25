from copy import deepcopy
from datetime import datetime, timedelta, timezone
from hashlib import sha1
from itertools import combinations
import json
import os
import ssl
import unittest
from unittest.mock import patch

from back.classify import Classifier, MAX_BODY
from back.events import (Pair, EventMatcher, CRITERIA, title_overlap,
                         candidate_pairs, group_events)
from back.feedparse import dedup_key
from tests.test_classify import server


def article(n, hours=0, title='同一新聞事件報導', source='甲', **overrides):
    return dict(title=title, summary='摘要', source=source, link=f'https://example.com/{n}',
                published=(datetime(2026, 9, 24, tzinfo=timezone.utc) + timedelta(hours=hours)).isoformat(),
                **overrides)


def record(n, title='標題', summary='摘要'):
    return (f'private-key-{n}', title, summary)


def disjoint(n):
    return [Pair(record(2 * i), record(2 * i + 1), 0.5) for i in range(n)]


def answers(payload, choice='same', probability=0.9):
    return {'answers': {name: {'choice': choice, 'probabilities': {choice: probability}}
                        for name in payload['questions']}}


def respond(payload, *_):
    return 200, answers(payload), {}


def edge(left, right):
    return frozenset((dedup_key(left['link']), dedup_key(right['link'])))


class CandidateTests(unittest.TestCase):
    def test_short_titles_remain_candidates_but_cannot_auto_merge(self):
        for left, right, automatic in [('AI', 'Taiwan earthquake', False),
                                       ('abcdef', 'abcdefghijk', False),
                                       ('abcdefghijk', 'abcdef', False),
                                       ('aaaaaaa', 'aaaaaaaaaa', False),
                                       ('abcdefg', 'abcdefghijk', True)]:
            with self.subTest(left=left, right=right):
                pair, = candidate_pairs([article(0, title=left), article(1, title=right)])
                self.assertEqual(pair.similarity, 1)
                self.assertEqual(pair.automatic, automatic)

    def test_zero_width_matching_preserves_zwj(self):
        from back.events import _bigrams
        title = '台積電擴建晶圓廠'
        for separator in '\u200b\u200c\u2060\ufeff':
            with self.subTest(separator=repr(separator)):
                dirty = separator.join(title)
                pair, = candidate_pairs([article(0, title=title), article(1, title=dirty)])
                self.assertEqual(pair.similarity, 1)
                self.assertTrue(pair.automatic)
                self.assertEqual(pair.right[1], dirty)
        self.assertEqual(_bigrams('👩\u200d💻'), {('👩', '\u200d'), ('\u200d', '💻')})

    def test_bigram_normalization_and_overlap_not_jaccard(self):
        self.assertEqual(title_overlap('ＡI，台積電！ A-B\n', 'ａi台積電ab'), 1)
        self.assertEqual(title_overlap('ABCDEF', 'abcd'), 1)
        self.assertEqual(title_overlap('abcdef', 'abghij'), 0.2)
        self.assertEqual(title_overlap('abghij', 'abcdef'), 0.2)
        self.assertEqual(title_overlap('aaaaa', 'aa'), 1)  # set, not occurrence count
        self.assertEqual(title_overlap('abc', 'xyz'), 0)

    def test_empty_punctuation_and_single_character_have_no_bigrams(self):
        for title in ['', ' ，！\n', 'a']:
            self.assertEqual(title_overlap(title, title), 0)
            self.assertEqual(title_overlap(title, 'abc'), 0)

    def test_candidate_window_includes_36_hours_but_not_more(self):
        for hours, expected in [(36, 1), (-36, 1), (36 + 1 / 3600, 0), (-36 - 1 / 3600, 0)]:
            with self.subTest(hours=hours):
                self.assertEqual(len(candidate_pairs([article(0), article(1, hours)])), expected)

    def test_window_compares_instants_with_timezone_offsets(self):
        first, second = article(0), article(1)
        second['published'] = '2026-09-25T20:00:00+08:00'
        self.assertEqual(len(candidate_pairs([first, second])), 1)

    def test_candidate_and_auto_thresholds_are_inclusive(self):
        for left, right, expected, automatic in [
            ('abcdef', 'abghij', 1, False),
            ('abcdefg', 'abghijk', 0, False),
            ('abcdefghijk', 'abcdefghijZ', 1, True),
            ('abcdefghijk', 'abcdefghiYZ', 1, False),
        ]:
            with self.subTest(right=right):
                pairs = candidate_pairs([article(0, title=left), article(1, title=right)])
                self.assertEqual(len(pairs), expected)
                if pairs:
                    self.assertEqual(pairs[0].automatic, automatic)

    def test_unique_unordered_pairs_all_categories_without_mutating_items(self):
        items = [article(0, category='finance'), article(1, category='society'), article(2, category='tech')]
        alias = dict(items[0], link=items[0]['link'] + '?utm_source=x#anchor')
        items.append(alias)
        original = deepcopy(items)
        pairs = candidate_pairs(items)
        self.assertEqual(len(pairs), 3)
        self.assertEqual(len({pair.key for pair in pairs}), 3)
        self.assertEqual(pairs[0].left, (dedup_key(items[0]['link']), items[0]['title'], items[0]['summary']))
        self.assertEqual(items, original)


class MatcherTests(unittest.TestCase):
    def client(self, url, **kwargs):
        return EventMatcher(endpoint=url, key='events-secret-test', log=lambda _: None, **kwargs)

    def test_short_high_overlap_pair_goes_to_model(self):
        pair, = candidate_pairs([article(0, title='AI'), article(1, title='Taiwan earthquake')])
        with server(lambda p, *_: (200, answers(p, 'different'), {})) as (url, received):
            self.assertEqual(self.client(url).match([pair]), {pair.key: False})
            self.assertEqual(len(received), 1)
        client = self.client('http://127.0.0.1:9')
        client.enabled = False
        self.assertEqual(list(client.match_round([pair])), [])

    def test_exact_request_shape_named_pairs_and_deduplicated_state(self):
        a, b, c = record(0, '甲'), record(1, '乙'), record(2, '丙')
        pairs = [Pair(a, b, 0.2), Pair(b, c, 0.4), Pair(b, a, 0.2)]
        with server(respond) as (url, received):
            result = self.client(url).match(pairs)
        self.assertEqual(result, {pairs[0].key: True, pairs[1].key: True})
        path, headers, payload = received[0]
        self.assertEqual(path, '/jev')
        self.assertEqual({k.lower(): v for k, v in headers.items()}['authorization'], 'Bearer events-secret-test')
        self.assertEqual(set(payload), {'model', 'state', 'questions'})
        self.assertEqual(payload['model'], 'jev-1.13.0')
        # Reversed duplicate retains its first position, but its own endpoint order is valid.
        self.assertEqual(payload['state'], {'news_0': {'title': '乙', 'summary': '摘要'},
                                           'news_1': {'title': '甲', 'summary': '摘要'},
                                           'news_2': {'title': '丙', 'summary': '摘要'}})
        for i, (a_index, b_index) in enumerate([(0, 1), (0, 2)]):
            self.assertEqual(payload['questions'][f'same_{i}'], {
                'type': 'choice',
                'instructions': f'news_{a_index} 與 news_{b_index} 是否在報導同一個事件（同一件事、同一個發布或同一段行情）？',
                'criteria': {'same': '是同一個事件', 'related': '主題相關但不是同一個事件', 'different': '不同事件'},
            })
        self.assertEqual(set(payload['questions']), {'same_0', 'same_1'})
        self.assertNotIn('private-key', json.dumps(payload))

    def test_auto_pairs_never_sent_even_when_disabled(self):
        auto = candidate_pairs([article(0, title='abcdefghijk'), article(1, title='abcdefghijZ')])[0]
        pending = disjoint(1)[0]
        with server(respond) as (url, received):
            client = self.client(url)
            self.assertEqual(client.match([auto]), {auto.key: True})
            self.assertEqual(received, [])
            self.assertEqual(list(client.match_round([auto, pending])), [{auto.key: True}, {pending.key: True}])
            self.assertEqual(len(received), 1)
            self.assertEqual(len(received[0][2]['questions']), 1)
            self.assertNotIn(auto.left[1], json.dumps(received[0][2], ensure_ascii=False))
            client.enabled = False
            self.assertEqual(list(client.match_round([auto, pending])), [{auto.key: True}])
            self.assertEqual(len(received), 1)

    def test_state_twenty_limit_independently_splits_batches(self):
        pairs = disjoint(11)
        with server(respond) as (url, received):
            results = list(self.client(url).match_round(pairs))
        self.assertEqual([len(result) for result in results], [10, 1])
        self.assertEqual([len(p['state']) for _, _, p in received], [20, 2])
        self.assertEqual(set(received[1][2]['questions']), {'same_0'})
        self.assertEqual(set(received[1][2]['state']), {'news_0', 'news_1'})

    def test_forty_question_limit_independently_splits_batches(self):
        pairs = [Pair(a, b, 0.5) for a, b in combinations([record(i) for i in range(10)], 2)]
        with server(respond) as (url, received):
            results = list(self.client(url).match_round(pairs))
        self.assertEqual([len(result) for result in results], [40, 5])
        self.assertTrue(all(len(p['state']) <= 10 for _, _, p in received))

    def test_eight_thousand_characters_counts_unique_state_title_and_summary(self):
        a, b, c = [record(i, '中' * 2000, '文' * 2000) for i in range(3)]
        pairs = [Pair(a, b, 0.5), Pair(a, c, 0.5)]
        with server(respond) as (url, received):
            results = list(self.client(url).match_round(pairs))
        self.assertEqual([len(result) for result in results], [1, 1])
        self.assertEqual([sum(len(i['title']) + len(i['summary']) for i in p['state'].values())
                          for _, _, p in received], [8000, 8000])
        # A shared state item counts once even when it appears in many questions.
        a, b, c = [record(i, '中' * 1000, '文' * 1000) for i in range(3)]
        with server(respond) as (url, received):
            self.assertEqual(len(list(self.client(url).match_round([Pair(a, b, .5), Pair(a, c, .5)]))), 1)
            self.assertEqual(len(received[0][2]['state']), 3)

    def test_same_threshold_079_and_080_raw_max(self):
        for probability, expected in [(0.79, False), (0.8, True), (1, True), (0.34, False)]:
            with self.subTest(probability=probability), server(lambda p, *_: (200, answers(p, probability=probability), {})) as (url, _):
                self.assertEqual(self.client(url).match(disjoint(1)), {disjoint(1)[0].key: expected})
        def response(payload, *_):
            body = answers(payload, probability=0.2)
            body['answers']['same_0']['probabilities']['related'] = 0.8
            return 200, body, {}
        with server(response) as (url, _):
            self.assertTrue(self.client(url).match(disjoint(1))[disjoint(1)[0].key])

    def test_related_and_different_are_false_even_at_full_confidence(self):
        for choice in ['related', 'different']:
            with self.subTest(choice=choice), server(lambda p, *_: (200, answers(p, choice, 1), {})) as (url, _):
                self.assertEqual(self.client(url).match(disjoint(1)), {disjoint(1)[0].key: False})

    def test_invalid_answer_rejects_whole_batch(self):
        bad = [None, [], {}, {'choice': 'same'}, {'choice': 'other', 'probabilities': {'same': 1}},
               {'choice': [], 'probabilities': {'same': 1}},
               *[{'choice': 'same', 'probabilities': p} for p in [None, [], {}, {'same': True}, {'same': '1'},
                                                               {'same': -1}, {'same': 1.01}, {'same': float('nan')}]]]
        for value in bad:
            def response(payload, *_):
                body = answers(payload)
                body['answers']['same_1'] = value
                return 200, body, {}
            with self.subTest(value=value), server(response) as (url, _):
                self.assertIsNone(self.client(url).match(disjoint(2)))

    def test_missing_answer_and_malformed_envelope_reject_whole_batch(self):
        for body in [b'invalid', [], {}, {'answers': []}, {'answers': {'same_0': {'choice': 'same', 'probabilities': {'same': 1}}}}]:
            with self.subTest(body=body), server(lambda *_: (200, body, {})) as (url, _):
                self.assertIsNone(self.client(url).match(disjoint(2)))

    def test_one_mib_limit_and_truncation(self):
        body = json.dumps(answers({'questions': {'same_0': {}}})).encode()
        for payload, headers, valid in [(body + b' ' * (MAX_BODY-len(body)), {}, True),
                                        (body + b' ' * (MAX_BODY+1-len(body)), {}, False),
                                        (body, {'Content-Length': str(len(body) + 1)}, False)]:
            with self.subTest(valid=valid, headers=headers), server(lambda *_: (200, payload, headers)) as (url, _):
                self.assertEqual(self.client(url).match(disjoint(1)) is not None, valid)

    def test_401_403_permanently_disable_shared_clients(self):
        for status in [401, 403]:
            with self.subTest(status=status), server(lambda *_: (status, {}, {})) as (url, received):
                classifier = Classifier(endpoint=url, key='secret', log=lambda _: None)
                client = EventMatcher(shared=classifier)
                self.assertEqual(list(client.match_round(disjoint(11))), [])
                self.assertFalse(client.enabled)
                self.assertFalse(classifier.enabled)
                self.assertIsNone(client.match(disjoint(1)))
                self.assertIsNone(classifier.classify([record(0)]))
                self.assertEqual(len(received), 1)

    def test_transient_failures_stop_round_but_allow_next_round(self):
        for status in [429, 500, 'timeout']:
            def response(payload, n, release):
                if n <= (3 if status == 429 else 1):
                    if status == 'timeout':
                        release.wait(0.1)
                        return respond(payload)
                    return status, {}, {}
                return respond(payload)
            with self.subTest(status=status), server(response) as (url, received):
                client = self.client(url, timeout=0.02, sleep=lambda _: None)
                self.assertEqual(list(client.match_round(disjoint(11))), [])
                self.assertEqual(len(received), 3 if status == 429 else 1)
                self.assertTrue(client.enabled)
                self.assertEqual(len(list(client.match_round(disjoint(1)))), 1)

    def test_later_failure_keeps_only_previous_complete_batches(self):
        with server(lambda p, n, _: respond(p) if n == 1 else (200, {}, {})) as (url, received):
            results = list(self.client(url).match_round(disjoint(21)))
            self.assertEqual([len(result) for result in results], [10])
            self.assertEqual(len(received), 2)

    def test_sixty_second_budget_resets_between_rounds(self):
        now = [0]
        def response(payload, *_):
            now[0] += 30
            return respond(payload)
        with server(response) as (url, received):
            client = self.client(url, clock=lambda: now[0], read_deadline=120)
            self.assertEqual([len(result) for result in client.match_round(disjoint(31))], [10, 10])
            self.assertEqual(len(received), 2)
            self.assertEqual(now[0], 60)
            self.assertEqual(len(list(client.match_round(disjoint(1)))), 1)

    def test_empty_oversize_and_duplicate_pairs(self):
        too_many_questions = [Pair(a, b, .5) for a, b in combinations([record(i) for i in range(10)], 2)]
        with server(respond) as (url, received):
            client = self.client(url)
            self.assertEqual(client.match([]), {})
            self.assertEqual(list(client.match_round([])), [])
            for pairs in [disjoint(11), too_many_questions, [Pair(record(0, 'x'*8001), record(1), .5)]]:
                self.assertIsNone(client.match(pairs))
            self.assertEqual(list(client.match_round([Pair(record(0, 'x'*8001), record(1), .5)])), [])
            self.assertEqual(received, [])
            self.assertEqual(len(list(client.match_round(disjoint(1) * 41))), 1)
            self.assertEqual(len(received[0][2]['questions']), 1)

    def test_default_key_endpoint_timeout_tls_and_secret_not_logged(self):
        with patch.dict(os.environ, {'TYPESAFE_API_KEY': '', 'NEWS_TEST_JEV_URL': 'http://invalid'}, clear=True):
            disabled = EventMatcher(log=lambda _: None)
        self.assertFalse(disabled.enabled)
        self.assertEqual(disabled.endpoint, 'https://api.typesafe.ai/v1/systemone')
        logs = []
        client = EventMatcher(key='events-unique-secret', log=logs.append)
        self.assertEqual(client.timeout, 15)
        self.assertEqual(client.budget, 60)
        self.assertEqual(client.ssl_context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(client.ssl_context.check_hostname)
        with patch.object(client._opener, 'open', side_effect=OSError('events-unique-secret')) as opened:
            self.assertIsNone(client.match(disjoint(1)))
            self.assertEqual(opened.call_args.kwargs['timeout'], 15)
        self.assertNotIn('events-unique-secret', ''.join(logs))


class GroupTests(unittest.TestCase):
    def group(self, items, pairs):
        return group_events(items, {edge(a, b): True for a, b in pairs}, ['甲', '乙'])

    def test_union_find_transitive_chain(self):
        a, b, c = article(0), article(1, 8), article(2, 16)
        groups = self.group([c, b, a], [(a, b), (b, c)])
        self.assertEqual(len({value['event'] for value in groups.values()}), 1)
        self.assertEqual({value['event_size'] for value in groups.values()}, {3})

    def test_24_hour_guard_and_inclusive_boundary(self):
        a, b, c, d = article(0), article(1, 12), article(2, 24), article(3, 24 + 1 / 3600)
        groups = self.group([d, c, b, a], [(a, b), (b, c), (c, d)])
        self.assertEqual(groups[a['link']]['event_size'], 3)
        self.assertEqual(groups[d['link']]['event_size'], 1)
        self.assertNotEqual(groups[a['link']]['event'], groups[d['link']]['event'])

    def test_guard_checks_all_members_when_merging_existing_groups(self):
        a, b, c, d = article(0), article(1, 10), article(2, 20), article(3, 30)
        groups = self.group([a, b, c, d], [(a, b), (c, d), (b, c)])
        self.assertEqual(groups[d['link']]['event_size'], 1)
        self.assertEqual(groups[a['link']]['event_size'], 3)
        # Both existing groups fit individually. Their representatives are only
        # 10h apart, but merging would put the final member 30h after the first.
        a, b, c, d = article(0, 0), article(1, 20), article(2, 10), article(3, 30)
        groups = self.group([a, b, c, d], [(a, b), (c, d), (b, d)])
        self.assertEqual(groups[a['link']]['event'], groups[b['link']]['event'])
        self.assertEqual(groups[c['link']]['event'], groups[d['link']]['event'])
        self.assertNotEqual(groups[a['link']]['event'], groups[c['link']]['event'])
        self.assertEqual({value['event_size'] for value in groups.values()}, {2})

    def test_earliest_representative_then_feed_order_then_key(self):
        older, newer = article(0, source='乙'), article(1, 1, source='甲')
        groups = self.group([newer, older], [(older, newer)])
        self.assertEqual(groups[newer['link']]['event'], sha1(older['link'].encode()).hexdigest()[:12])
        first, second = article(0, source='乙'), article(1, source='甲')
        groups = self.group([first, second], [(first, second)])
        self.assertEqual(groups[first['link']]['event'], sha1(second['link'].encode()).hexdigest()[:12])
        second['source'] = '乙'
        groups = self.group([second, first], [(first, second)])
        self.assertEqual(groups[first['link']]['event'], sha1(first['link'].encode()).hexdigest()[:12])

    def test_ids_stable_input_and_result_order_invariant_and_inputs_unchanged(self):
        items = [article(0), article(1, 12), article(2, 24), article(3, 36)]
        matches = {edge(items[2], items[3]): True, edge(items[1], items[2]): True, edge(items[0], items[1]): True}
        original = deepcopy((items, matches))
        result = group_events(items, matches, ['甲'])
        self.assertEqual(result, group_events(list(reversed(items)), dict(reversed(list(matches.items()))), ['甲']))
        for value in result.values():
            self.assertRegex(value['event'], r'^[0-9a-f]{12}$')
        self.assertEqual((items, matches), original)

    def test_singletons_false_and_missing_edges_and_tracking_key(self):
        a, b = article(0), article(1)
        a['link'] += '?utm_source=test#fragment'
        matches = {edge(a, b): False, frozenset((b['link'], 'not-visible')): True}
        groups = group_events([a, b], matches, [])
        self.assertEqual(groups[dedup_key(a['link'])], {'event': sha1(dedup_key(a['link']).encode()).hexdigest()[:12], 'event_size': 1})
        self.assertEqual(groups[b['link']]['event_size'], 1)
        self.assertEqual(group_events([], {}, []), {})
