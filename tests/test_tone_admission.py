"""Tone eligibility is live top-five membership, including retries and empty acks."""
from copy import deepcopy
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from back.scheduler import Scheduler, ModelRound, ToneResult
from back.model_batches import plan_batch
from back.feedparse import dedup_key
from tests.test_topics import story, snapshot
from tests import test_tone_scheduler as tone_helpers


class ToneAdmissionTests(unittest.TestCase):
    setUp = tone_helpers.ToneSchedulerTests.setUp
    tearDown = tone_helpers.ToneSchedulerTests.tearDown
    make = tone_helpers.ToneSchedulerTests.make

    def test_planner_prunes_first_queue_and_packs_survivors_in_order(self):
        rows = [(str(i), 't', '') for i in range(25)]
        eligible = set(rows[2:])
        result = plan_batch('tone', rows[0], rows[1:], fits=lambda _: True, eligible=eligible)
        self.assertEqual(result.dropped, rows[:2])
        self.assertEqual(result.batch, rows[2:22])
        self.assertEqual(result.remaining, rows[22:])
        self.assertEqual(rows[0], ('0', 't', ''))

    def test_live_membership_content_and_cache_not_stale_decorations(self):
        items, _ = snapshot()
        s, _ = self.make('http://unused.invalid', items)
        s._emit(s.caches, [])
        initial = s._tone_admission()
        self.assertEqual({i[0] for i in initial}, {i['link'] for i in items[:3]})
        s.tone_cache[items[0]['link']] = 'neutral'
        s.last_list['body']['items'][1]['summary'] = 'revised'
        eligible = s._tone_admission()
        self.assertNotIn((items[0]['link'], items[0]['title'], items[0]['summary']), eligible)
        self.assertNotIn((items[1]['link'], items[1]['title'], items[1]['summary']), eligible)
        self.assertIn((items[1]['link'], items[1]['title'], 'revised'), eligible)
        # Visible packet still has a topic, but current accepted plan no longer does.
        s.last_list['body']['items'] = s.last_list['body']['items'][2:]
        self.assertEqual(s._tone_admission(), set())

    def test_sixth_topic_excluded_using_live_plan(self):
        items, _ = snapshot()
        s, _ = self.make('http://unused.invalid', items)
        s._emit(s.caches, [])
        rows, groups = [], {}
        for n in range(6):
            for source in 'ABC':
                item = story(f'{n}-{source}', f'TERM{n}', source, n)
                rows.append(item)
                groups[item['link']] = {'event': str(n)}
        s.last_list['body']['items'] = rows
        with patch.object(s, '_pairs_for', return_value=[]), patch('back.scheduler.group_events', return_value=groups):
            topics, _ = s._topic_plan(s.last_list, groups)
            eligible = s._tone_admission()
        expected = {key for t in topics for key in t['keys']}
        self.assertEqual(len(topics), 5)
        self.assertEqual(len(eligible), 15)
        self.assertEqual({i[0] for i in eligible}, expected)
        self.assertEqual(len({i['link'] for i in rows} - expected), 3)

    def test_empty_batch_original_round_waits_for_coordinator_and_releases(self):
        s = Scheduler([{'name': 'A'}], None, None, 1, log=lambda _: None)
        work = ModelRound(9)
        s.model_rounds[9] = work
        row = ('gone', 'title', '')
        s.tone_in_flight.add(row[0])
        lane = next(l for l in s.lanes if l.name == 'tone')
        with s.cv:
            batch, _ = s._take_batch(lane, work, row)
            self.assertEqual(batch, [])
            self.assertEqual(work.awaiting, 1)
            result = s.results.popleft()
            self.assertEqual(result.round_id, 9)
            self.assertTrue(result.accounted)
            self.assertEqual(result.finished, ('gone',))
            self.assertEqual(work.requests['tone'], 0)
            self.assertIn('gone', s.tone_in_flight)
            s._accept(result)
            self.assertEqual(work.awaiting, 0)
            self.assertFalse(s.tone_in_flight)
            self.assertFalse(work.failed)

    def test_requeue_revalidates_before_http_and_finishes_without_request(self):
        client = SimpleNamespace(enabled=True, clock=lambda: 0, budget=60,
                                 tone=lambda _: self.fail('stale HTTP'))
        s = Scheduler([{'name': 'A'}], None, None, 1, classifier=client, tone_client=client, log=lambda _: None)
        lane = next(l for l in s.lanes if l.name == 'tone')
        work = ModelRound(2)
        s.model_rounds[2] = work
        s.model_requeues.append((lane, work, [('gone', 't', '')], None))
        s.tone_in_flight.add('gone')
        def accept(result):
            self.assertIsInstance(result, ToneResult)
            self.assertEqual(result.round_id, 2)
            s._accept(result)
            s.stopping = True
            return True
        s._submit_classification = accept
        s._classify_worker()
        self.assertFalse(s.tone_in_flight)
        self.assertEqual(work.http, 0)
        self.assertEqual(work.requests['tone'], 0)
        self.assertEqual(work.awaiting, 0)
        self.assertFalse(work.failed)

    def test_round_boundary_preserved_and_valid_items_still_requested(self):
        s = Scheduler([{'name': 'A'}], None, None, 1)
        work, later = ModelRound(1), ModelRound(2)
        a, b, c = [(k, 't', '') for k in 'abc']
        s._tone_admission = lambda: {b, c}
        s.tone_jobs.put((work, b))
        s.tone_jobs.put((later, c))
        lane = next(l for l in s.lanes if l.name == 'tone')
        with s.cv:
            batch, _ = s._take_batch(lane, work, a)
        self.assertEqual(batch, [b])
        self.assertEqual(list(s.tone_jobs.queue), [(later, c)])
        self.assertEqual(s.results[0].finished, ('a',))
