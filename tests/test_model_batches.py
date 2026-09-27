"""Packing policy without workers, clocks, clients or mutable input queues."""
from copy import deepcopy
import unittest

from back.model_batches import plan_batch
from back.events import Pair, _fits
from back.topics import TopicPair, fits as topic_fits
from back.scheduler import Scheduler, ModelRound, _items_fit


def item(key, chars=1):
    return (key, 'x' * chars, '')


def pair(seed, member, chars=1):
    return TopicPair(item(seed, chars), item(member, chars))


class ModelBatchTests(unittest.TestCase):
    def test_simple_lanes_count_limit_and_fifo(self):
        for lane in ('classify', 'tone'):
            with self.subTest(lane=lane):
                pending = [item(str(i)) for i in range(1, 25)]
                plan = plan_batch(lane, item('0'), pending, fits=lambda _: True)
                self.assertEqual(plan.batch, [item(str(i)) for i in range(20)])
                self.assertEqual(plan.remaining, pending[19:])
                self.assertEqual(plan.dropped, [])
                self.assertIsNone(plan.kind)

    def test_simple_lanes_stop_at_first_character_overflow(self):
        for lane in ('classify', 'tone'):
            plan = plan_batch(lane, item('a', 4000), [item('b', 4001), item('c')], fits=_items_fit)
            self.assertEqual(plan.batch, [item('a', 4000)])
            self.assertEqual(plan.remaining, [item('b', 4001), item('c')])

    def test_oversized_first_preserved_for_client_failure(self):
        plan = plan_batch('classify', item('a', 8001), [item('b')], fits=_items_fit)
        self.assertEqual(plan.batch, [item('a', 8001)])
        self.assertEqual(plan.remaining, [item('b')])

    def test_analysis_homogeneous_kind_preserves_other_positions(self):
        categories = dict(a='tech', b='world', c='finance', d='politics', e='tech')
        plan = plan_batch('analysis', item('a'), [item(k) for k in 'bcde'],
                          fits=_items_fit, categories=categories)
        self.assertEqual(plan.kind, 'finance')
        self.assertEqual(plan.batch, [item(k) for k in 'ace'])
        self.assertEqual(plan.remaining, [item(k) for k in 'bd'])
        for category in ('world', 'politics'):
            plan = plan_batch('analysis', item('a'), [item('b')], fits=_items_fit,
                              categories={'a': category, 'b': category})
            self.assertEqual(plan.kind, category)
            self.assertEqual(len(plan.batch), 2)

    def test_analysis_stop_on_matching_kind_overflow_not_skip(self):
        plan = plan_batch('analysis', item('a', 4000), [item('b'), item('c', 4001), item('d')],
                          fits=_items_fit, categories={'b': 'world'})
        self.assertEqual(plan.batch, [item('a', 4000)])
        self.assertEqual(plan.remaining, [item('b'), item('c', 4001), item('d')])
        self.assertEqual(plan.kind, 'finance')

    def test_analysis_independent_count_guard(self):
        pending = [item(str(i)) for i in range(30)]
        plan = plan_batch('analysis', item('first'), pending, fits=lambda _: True)
        self.assertEqual(len(plan.batch), 20)
        self.assertEqual(plan.remaining, pending[19:])

    def test_topics_revalidate_first_and_all_pending_without_losing_remaining(self):
        first = pair('s', 'old')
        pending = [pair('t', 'a'), pair('s', 'gone'), pair('t', 'b'), pair('s', 'c')]
        eligible = {'s': {'c'}, 't': {'a', 'b'}}
        before = deepcopy((first, pending, eligible))
        plan = plan_batch('topics', first, pending, fits=topic_fits, eligible=eligible)
        self.assertEqual(plan.batch, [pending[0], pending[2]])
        self.assertEqual(plan.remaining, [pending[3]])
        self.assertEqual(plan.dropped, [first, pending[1]])
        self.assertEqual((first, pending, eligible), before)

    def test_topics_skip_large_candidate_and_continue_same_seed(self):
        first = pair('s', 'a', 3000)
        large = TopicPair(first.left, item('b', 3000))
        small = TopicPair(first.left, item('c'))
        plan = plan_batch('topics', first, [large, small], fits=topic_fits,
                          eligible={'s': {'a', 'b', 'c'}})
        self.assertEqual(plan.batch, [first, small])
        self.assertEqual(plan.remaining, [large])
        self.assertEqual(plan.dropped, [])

    def test_topics_empty_and_question_limit(self):
        first = pair('s', 'first')
        self.assertEqual(plan_batch('topics', first, [], fits=topic_fits).dropped, [first])
        pending = [pair('s', str(i)) for i in range(25)]
        plan = plan_batch('topics', first, pending, fits=topic_fits,
                          eligible={'s': {'first', *(str(i) for i in range(25))}})
        self.assertEqual(len(plan.batch), 19)
        self.assertEqual(plan.remaining, pending[18:])

    def test_events_pack_shared_endpoints_and_preserve_input(self):
        first = Pair(item('x'), item('y'), .5)
        pending = [Pair(item('hub'), item(str(i)), .5) for i in range(22)]
        before = deepcopy(pending)
        plan = plan_batch('events', first, pending, fits=_fits)
        self.assertEqual(plan.batch[0], pending[0])
        self.assertEqual(len(plan.batch), 19)
        self.assertEqual(plan.remaining, [first, *pending[19:]])
        self.assertEqual(pending, before)
        self.assertTrue(_fits(plan.batch))

    def test_adapter_never_crosses_round_and_keeps_suffix_order(self):
        scheduler = Scheduler([{'name': 'x'}], None, None, 1)
        work, later = ModelRound(1), ModelRound(2)
        for name in ('classify', 'analysis', 'tone', 'events', 'topics'):
            lane = next(l for l in scheduler.lanes if l.name == name)
            a, b, c, d = ([pair('s', k) for k in 'abcd'] if lane.pair
                          else [item(k) for k in 'abcd'])
            if name == 'events':
                a, b, c, d = [Pair(p.left, p.right, .5) for p in (a, b, c, d)]
            scheduler._topic_admission = lambda: {'s': set('abcd')}
            for entry in ((work, b), (later, c), (work, d)):
                lane.jobs.put_nowait(entry)
            with scheduler.cv:
                batch, _ = scheduler._take_batch(lane, work, a)
            self.assertEqual(batch, [a, b], name)
            self.assertEqual(list(lane.jobs.queue), [(later, c), (work, d)], name)

    def test_adapter_empty_topic_acknowledges_original_round_before_close(self):
        scheduler = Scheduler([{'name': 'x'}], None, None, 1)
        work = ModelRound(7, started=0)
        scheduler.model_rounds[7] = work
        scheduler._topic_admission = lambda: {}
        lane = next(l for l in scheduler.lanes if l.name == 'topics')
        first = pair('s', 'a')
        with scheduler.cv:
            batch, kind = scheduler._take_batch(lane, work, first)
            scheduler._finish_model_rounds()
        self.assertEqual(batch, [])
        self.assertIsNone(kind)
        self.assertEqual(work.awaiting, 1)
        self.assertFalse(work.logged)
        result = scheduler.results[0]
        self.assertEqual(result.round_id, 7)
        self.assertEqual(result.finished, (first.key,))
        self.assertTrue(result.accounted)
        self.assertEqual(sum(work.requests.values()), 0)

    def test_unknown_lane_rejected(self):
        with self.assertRaises(ValueError):
            plan_batch('unknown', item('a'), [], fits=_items_fit)
