from collections import OrderedDict
from copy import deepcopy
from hashlib import sha1
import json
from pathlib import Path
import queue
import threading
import unittest
from unittest.mock import patch

from back.analyze import Analyzer
from back.classify import Classifier
from back.events import EventMatcher, candidate_pairs
from back.feedparse import MAX_ITEMS_LIST, MAX_PACKET, dedup_key, fit_packet, packet_bytes
from back.fetch import Result
from back.scheduler import Cache, EventResult, ModelRound
from tests.test_classify import server
from tests.test_events import article, disjoint, edge
from tests import test_scheduler as helpers
from tests.test_scheduler import eventually


def response(payload, *_):
    from tests.test_analyze import answers
    if 'market_0' in payload['questions']:
        return 200, answers(len(payload['state'])), {}
    choice = 'same' if 'same_0' in payload['questions'] else 'finance'
    return 200, {'answers': {name: {'choice': choice, 'probabilities': {choice: .9}}
                             for name in payload['questions']}}, {}


def kind(payload):
    return 'events' if 'same_0' in payload['questions'] else 'analysis' if 'market_0' in payload['questions'] else 'classify'


class EventSchedulerTests(unittest.TestCase):
    setUp = helpers.SchedulerTests.setUp
    def tearDown(self):
        for scheduler in self.schedulers:
            scheduler.stop()
        for gate in self.gates:
            gate.set()
        for scheduler in self.schedulers:
            threads = scheduler.workers + [scheduler.coordinator]
            threads.extend(scheduler.classify_workers)
            for thread in threads:
                if thread.ident is not None:
                    thread.join(timeout=2)
                    self.assertFalse(thread.is_alive())
    gate = helpers.SchedulerTests.gate
    create = helpers.SchedulerTests.create
    round = helpers.SchedulerTests.round

    def clients(self, url, **options):
        classifier = Classifier(endpoint=url, key='event-integration-secret', log=lambda _: None, **options)
        return dict(classifier=classifier, analyzer=Analyzer(shared=classifier), matcher=EventMatcher(shared=classifier))

    def make(self, items, clients=None, cached=True, **options):
        scheduler, sink, logs = self.create(lambda *_: Result('not_modified'), **(clients or {}), **options)
        if len({item['source'] for item in items}) > 1:
            scheduler.feeds = json.loads((Path(__file__).parents[1] / 'back/feeds.json').read_text())
            scheduler.last_success = [None for _ in scheduler.feeds]
            scheduler.caches = [Cache([deepcopy(item) for item in items if item['source'] == feed['name']],
                                      available=True) for feed in scheduler.feeds]
        else:
            scheduler.caches[0] = Cache(deepcopy(items), available=True)
        if cached:
            for item in items:
                key = dedup_key(item['link'])
                scheduler.classify_cache[key] = 'society'
        return scheduler, sink, logs

    def pair_items(self):
        return [article(0, title='abcdef'), article(1, title='abghij')]

    def idle(self, scheduler):
        with scheduler.cv:
            return not (scheduler.in_flight or scheduler.analysis_in_flight or scheduler.event_in_flight)

    def test_auto_merge_without_key_or_model_thread(self):
        items = [article(0), article(1), article(2, title='unrelated')]
        scheduler, sink, _ = self.make(items)
        scheduler.start()
        body = self.round(sink)
        self.assertEqual(scheduler.classify_workers, [])
        self.assertEqual(body['events'], {'pending': 0})
        self.assertEqual(sorted(i['event_size'] for i in body['items']), [1, 2, 2])
        for item in body['items']:
            self.assertRegex(item['event'], r'^[a-f0-9]{12}$')
        self.assertEqual(scheduler.event_cache[edge(*items[:2])], True)
        self.assertEqual(scheduler.event_jobs.qsize(), 0)

    def test_pair_results_resend_same_at_without_publish_cache_hit_zero_requests(self):
        gate, entered = self.gate(), threading.Event()
        def respond(payload, *_):
            entered.set()
            gate.wait()
            return response(payload)
        with server(respond) as (url, received):
            scheduler, sink, _ = self.make(self.pair_items(), self.clients(url))
            scheduler.start()
            initial = self.round(sink)
            self.assertTrue(entered.wait(1))
            self.assertEqual(initial['events']['pending'], 1)
            gate.set()
            final = sink.packets.get(timeout=2)
            self.assertEqual(final['t'], 'msg')
            self.assertEqual(final['body']['at'], initial['at'])
            self.assertEqual(final['body']['events']['pending'], 0)
            self.assertTrue(all(i['event_size'] == 2 for i in final['body']['items']))
            eventually(lambda: self.idle(scheduler))
            self.assertTrue(sink.packets.empty())
            scheduler.refresh()
            self.assertEqual(self.round(sink)['events']['pending'], 0)
            eventually(lambda: scheduler.completed == 2)
            self.assertEqual(len(received), 1)

    def test_false_redundant_invisible_and_active_results_do_not_resend(self):
        items = self.pair_items() + [article(2, title='abklmn')]
        scheduler, sink, _ = self.make(items, self.clients('http://127.0.0.1:9'))
        scheduler._emit(scheduler.caches, [])
        self.round(sink)
        pair = edge(items[0], items[1])
        with scheduler.cv:
            self.assertIsNone(scheduler._accept(EventResult({pair: False}, (pair,), -100)))
            self.assertIn(pair, scheduler.event_cache)
            self.assertIsNone(scheduler._accept(EventResult({frozenset(('not', 'visible')): True})))
            scheduler.active = True
            self.assertIsNone(scheduler._accept(EventResult({pair: True}, round_id=-100)))
            scheduler.active = False
            update = scheduler._accept(EventResult({edge(items[1], items[2]): True}, round_id=-200))
        self.assertIsNotNone(update)
        scheduler._send_list(update)
        sink.packets.get_nowait()
        with scheduler.cv:
            final = scheduler._accept(EventResult({edge(items[0], items[2]): True}))
        self.assertEqual(final['body']['events']['pending'], 0)
        scheduler._send_list(final)
        sink.packets.get_nowait()
        with scheduler.cv:
            self.assertIsNone(scheduler._accept(EventResult({edge(items[0], items[2]): True})))
        self.assertTrue(sink.packets.empty())

    def test_pair_cache_fifo_20000_accepts_only_bool_and_does_not_refresh_order(self):
        scheduler, _, _ = self.make([])
        pairs = {frozenset((f'a-{i}', f'b-{i}')): bool(i % 2) for i in range(20000)}
        oldest = next(iter(pairs))
        with scheduler.cv:
            scheduler._accept(EventResult(pairs))
            scheduler._accept(EventResult({oldest: True}))
            scheduler._accept(EventResult({frozenset(('x', 'y')): False, frozenset(('bad', 'value')): 1}))
        self.assertEqual(len(scheduler.event_cache), 20000)
        self.assertNotIn(oldest, scheduler.event_cache)
        self.assertNotIn(frozenset(('bad', 'value')), scheduler.event_cache)
        self.assertIs(scheduler.event_cache[frozenset(('x', 'y'))], False)

    @patch("back.scheduler.MODEL_WORKERS", 1)  # Serial regression; parallel admission covered in test_model_workers.
    def test_pair_priority_below_classification_above_analysis_at_batch_boundary(self):
        gate, entered = self.gate(), threading.Event()
        def respond(payload, n, _):
            if n == 1:
                entered.set()
                gate.wait()
            return response(payload)
        with server(respond) as (url, received):
            scheduler, sink, _ = self.make(self.pair_items(), self.clients(url))
            scheduler.start()
            self.round(sink)
            self.assertTrue(entered.wait(1))
            with scheduler.cv:
                work = ModelRound(99)
                scheduler.classify_jobs.put_nowait((work, ('new', 'new', '')))
                scheduler.in_flight.add('new')
                scheduler.analysis_jobs.put_nowait((work, ('analyze', 'analyze', '')))
                scheduler.analysis_in_flight.add('analyze')
                extra = disjoint(1)[0]
                scheduler.event_jobs.put_nowait((work, extra))
                scheduler.event_in_flight.add(extra.key)
                gate.set()
                scheduler.cv.notify_all()
            eventually(lambda: len(received) >= 4 and self.idle(scheduler))
            stages = [kind(payload) for _, _, payload in received]
            self.assertEqual(stages[0], 'events')
            self.assertEqual(stages[1], 'classify')
            self.assertEqual(stages[2], 'events')
            self.assertTrue(all(stage == 'analysis' for stage in stages[3:]))

    def test_queue_capacity_from_merge_constant_and_dedup_processing_keys(self):
        items = [article(i, title=f'abcdefghij{i:03d}xyz{i:03d}') for i in range(50)]
        scheduler, _, _ = self.make(items, self.clients('http://127.0.0.1:9'))
        packet = {'body': {'items': [dict(item, category='society') for item in items]}}
        scheduler._enqueue_classification(packet)
        self.assertEqual(scheduler.event_jobs.maxsize, MAX_ITEMS_LIST * 2)
        self.assertEqual(scheduler.event_jobs.qsize(), MAX_ITEMS_LIST * 2)
        self.assertEqual(len(scheduler.event_in_flight), MAX_ITEMS_LIST * 2)
        with scheduler.cv:
            processing = scheduler.event_jobs.get_nowait()[1]
        scheduler._enqueue_classification(packet)
        self.assertIn(processing.key, scheduler.event_in_flight)
        self.assertEqual(len(scheduler.event_in_flight), MAX_ITEMS_LIST * 2 + 1)
        self.assertFalse(any(pair.key == processing.key for _, pair in scheduler.event_jobs.queue))

    def test_failure_releases_inflight_and_retries_next_round(self):
        with server(lambda p, n, _: (500, {}, {}) if n == 1 else response(p)) as (url, received):
            scheduler, sink, _ = self.make(self.pair_items(), self.clients(url))
            scheduler.start()
            self.round(sink)
            eventually(lambda: len(received) == 1 and self.idle(scheduler))
            self.assertFalse(scheduler.event_cache)
            self.assertEqual(sink.packets.get(timeout=2)['body']['model'], {'state':'paused','reason':'failed'})
            scheduler.refresh()
            self.round(sink)
            self.assertEqual(sink.packets.get(timeout=2)['body']['events']['pending'], 0)
            self.assertEqual(len(received), 2)

    def test_auth_failure_in_any_stage_disables_all_three_and_releases_jobs(self):
        for stage in ['classify', 'events', 'analysis']:
            with self.subTest(stage=stage), server(lambda p, *_: (401, {}, {}) if kind(p) == stage else response(p)) as (url, received):
                clients = self.clients(url)
                scheduler, sink, _ = self.make(self.pair_items(), clients, cached=False)
                scheduler.start()
                self.round(sink)
                eventually(lambda: not clients['classifier'].enabled and self.idle(scheduler))
                self.assertTrue(all(not c.enabled for c in clients.values()))
                with scheduler.cv:
                    self.assertEqual(scheduler.last_list['body']['events']['pending'], 0)
                # Other requests admitted before authentication failed may finish later.
                self.assertIn(stage, [kind(p) for _, _, p in received])

    @patch("back.scheduler.MODEL_WORKERS", 1)  # Serial regression; parallel admission covered in test_model_workers.
    def test_shared_budget_classify_pair_analysis_and_remaining_work_next_round(self):
        now = [0]
        def respond(payload, *_):
            now[0] += 30
            return response(payload)
        with server(respond) as (url, received):
            # Isolate the shared round budget from the shorter response deadline.
            scheduler, sink, _ = self.make(self.pair_items(), self.clients(url, clock=lambda: now[0], read_deadline=120), cached=False)
            scheduler.start()
            self.round(sink)
            eventually(lambda: self.idle(scheduler))
            self.assertEqual([kind(p) for _, _, p in received], ['classify', 'events'])
            self.assertFalse(scheduler.analysis_cache)
            with scheduler.cv:
                self.assertEqual(scheduler.last_list['body']['events']['pending'], 0)
                self.assertEqual(scheduler.last_list['body']['analysis']['pending'], 2)
            while not sink.packets.empty():
                sink.packets.get_nowait()
            scheduler.refresh()
            self.round(sink)
            final = sink.packets.get(timeout=2)
            self.assertEqual(final['body']['analysis']['pending'], 0)
            self.assertEqual([kind(p) for _, _, p in received], ['classify', 'events', 'analysis'])

    def test_fit_recounts_visible_groups_and_pending(self):
        items = self.pair_items() + [article(2, title='abcdef')]
        def trim(packet):
            packet['body']['items'] = packet['body']['items'][:2]
            return fit_packet(packet)
        scheduler, sink, _ = self.make(items, self.clients('http://127.0.0.1:9'), fit=trim)
        scheduler._emit(scheduler.caches, [])
        body = self.round(sink)
        visible = body['items']
        self.assertEqual(body['events']['pending'], sum(p.key not in scheduler.event_cache for p in candidate_pairs(visible)))
        self.assertTrue(all(i['event_size'] == sum(j['event'] == i['event'] for j in visible) for i in visible))
        self.assertTrue(all('event' not in i for i in scheduler.caches[0].items))

    def test_event_size_reserve_keeps_item_count_when_singletons_become_300_group(self):
        # Build an envelope only 100 bytes below the limit before size growth.
        items = [article(i, title=sha1(str(i).encode()).hexdigest(), source='0') for i in range(MAX_ITEMS_LIST)]
        scheduler, sink, logs = self.make(items)
        with scheduler.cv:
            packet = scheduler._decorate({'t': 'msg', 'seq': 891, 'body': {
                'op': 'list', 'items': items, 'sources': [], 'at': scheduler.now().isoformat()}})
        padding = MAX_PACKET - len(packet_bytes(packet)) - 100
        packet['body']['padding'] = 'x' * (padding - len(', "padding": ""'))
        self.assertLessEqual(len(packet_bytes(packet)), MAX_PACKET)
        filled = deepcopy(packet)
        for item in filled['body']['items']:
            item.update(event='000000000000', event_size=300)
        self.assertGreater(len(packet_bytes(filled)), MAX_PACKET)
        scheduler._send_list(packet, publish=True)
        first = self.round(sink)
        keys = [dedup_key(i['link']) for i in first['items']]
        self.assertLess(len(keys), MAX_ITEMS_LIST)
        with scheduler.cv:
            update = scheduler._accept(EventResult({frozenset((keys[0], key)): True for key in keys[1:]}))
        scheduler._send_list(update)
        final = sink.packets.get(timeout=2)['body']
        self.assertEqual([i['link'] for i in first['items']], [i['link'] for i in final['items']])
        self.assertTrue(all(i['event_size'] == len(keys) for i in final['items']))
        self.assertEqual(logs, [])

    def test_real_300_snapshot_first_round_finishes_and_priority_holds(self):
        items = json.loads((Path(__file__).parent / 'fixtures/events-300-2026-09-24.json').read_text())
        self.assertEqual(len(items), MAX_ITEMS_LIST)
        with server(response) as (url, received):
            scheduler, sink, _ = self.make(items, self.clients(url), cached=False)
            admissions = []
            take_batch = scheduler._take_batch
            def record_admission(lane, work, first):
                admissions.append(lane.name)  # Called under cv, before concurrent HTTP starts.
                return take_batch(lane, work, first)
            scheduler._take_batch = record_admission
            scheduler.start()
            first = self.round(sink)
            self.assertEqual(len(first['items']), MAX_ITEMS_LIST)
            self.assertGreater(first['events']['pending'], 0)
            eventually(lambda: scheduler.completed == 1 and self.idle(scheduler), timeout=10)
            eventually(lambda: scheduler.last_list['body']['events']['pending'] == 0
                       and scheduler.last_list['body']['analysis']['pending'] == 0, timeout=3)
            with scheduler.cv:
                final = deepcopy(scheduler.last_list['body'])
                self.assertTrue(all(p.key in scheduler.event_cache for p in candidate_pairs(final['items'])))
            self.assertEqual(final['events']['pending'], 0)
            self.assertEqual(final['classify']['pending'], 0)
            self.assertEqual(final['analysis']['pending'], 0)
            self.assertEqual(len(final['items']), MAX_ITEMS_LIST)
            stages = [kind(p) for _, _, p in received]
            self.assertEqual(admissions, sorted(admissions, key=['classify', 'events', 'analysis'].index))
            self.assertCountEqual(stages, admissions)  # HTTP arrival order can differ from admission order.
            while not sink.packets.empty():
                packet = sink.packets.get_nowait()
                self.assertEqual(packet['t'], 'msg')
                self.assertEqual(packet['body']['at'], first['at'])

    def test_all_automatic_edges_exceeding_cache_capacity_still_merge_without_pending(self):
        feeds = json.loads((Path(__file__).parents[1] / 'back/feeds.json').read_text())
        items = [article(i, source=feeds[i % 5]['name']) for i in range(MAX_ITEMS_LIST)]
        scheduler, sink, _ = self.make(items, self.clients('http://127.0.0.1:9'))
        packet = scheduler._emit(scheduler.caches, [])
        body = self.round(sink)
        self.assertEqual(len(scheduler.event_cache), 20000)
        self.assertEqual(body['events']['pending'], 0)
        self.assertTrue(all(i['event_size'] == MAX_ITEMS_LIST for i in body['items']))
        scheduler._enqueue_classification(packet)
        self.assertTrue(scheduler.event_jobs.empty())
        self.assertFalse(scheduler.event_in_flight)

    @patch("back.scheduler.MODEL_WORKERS", 1)  # Serial regression; parallel admission covered in test_model_workers.
    def test_snapshot_budget_leaves_pairs_then_next_round_reduces_pending(self):
        items = json.loads((Path(__file__).parent / 'fixtures/events-300-2026-09-24.json').read_text())
        now = [0]
        def respond(payload, *_):
            now[0] += 10 if kind(payload) == 'events' else 1
            return response(payload)
        with server(respond) as (url, received):
            scheduler, sink, _ = self.make(items, self.clients(url, clock=lambda: now[0]), cached=False)
            scheduler.start()
            first = self.round(sink)
            eventually(lambda: self.idle(scheduler), timeout=10)
            with scheduler.cv:
                after = scheduler._decorate(deepcopy(scheduler.last_list))['body']['events']['pending']
            self.assertGreater(after, 0)
            self.assertLess(after, first['events']['pending'])
            # 15 classification batches, then event calls starting at 15..55.
            # The last permitted request finishes at 65; analysis must wait.
            self.assertEqual([kind(p) for _, _, p in received], ['classify'] * 15 + ['events'] * 5)
            self.assertEqual(now[0], 65)
            while not sink.packets.empty():
                sink.packets.get_nowait()
            scheduler.refresh()
            # A final first-round resend can still be serializing after its
            # in-flight acknowledgement. The new round's publish is the fence.
            while sink.packets.get(timeout=3)['t'] != 'publish':
                pass
            eventually(lambda: scheduler.completed == 2 and self.idle(scheduler), timeout=10)
            with scheduler.cv:
                remaining = scheduler._decorate(deepcopy(scheduler.last_list))['body']['events']['pending']
            self.assertLess(remaining, after)
            self.assertFalse(scheduler.event_in_flight)
