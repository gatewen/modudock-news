"""Seeded scheduler fault sequences; no sockets, credentials or real API.

NEWS_CHAOS_CASES defaults to 60; NEWS_CHAOS_SEED selects the first seed.
Each seed determines per-lane call plans and refresh snapshots independently
of worker scheduling. Thread interleavings themselves remain real.
"""
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from copy import deepcopy
import io
import json
import os
import random
import threading
import time
import unittest
from xml.sax.saxutils import escape

from back.analyze import Analyzer
from back.classify import Classifier
from back.events import EventMatcher
from back.fetch import Result
from back.scheduler import Scheduler
from back.topics import TopicMatcher, ToneClient
from tests.test_scheduler import FunctionFetcher, Sink, eventually


LANES = ('classify', 'events', 'topics', 'analysis', 'tone')


class Response(io.BytesIO):
    def __init__(self, code, body):
        super().__init__(json.dumps(body).encode())
        self.code = code
        self.length = len(self.getvalue())

    def read1(self, size):
        block = self.read(size)
        self.length -= len(block)
        return block


class Scenario:
    def __init__(self, seed, index):
        self.seed, self.index = seed, index
        self.rng = random.Random(seed)
        self.lock = threading.Lock()
        self.local = threading.local()
        self.entered = threading.Event()
        self.clean = False
        self.auth = False
        self.active = set()
        self.duplicates = []
        self.calls = Counter()
        self.outcomes = Counter()
        self.trace = []
        self.logs = []
        self.snapshots = [self.snapshot(version) for version in range(4)]
        self.current = self.snapshots[0]
        self.classifier = Classifier(key='chaos-fake-key', log=self.logs.append,
                                     sleep=self.retry_sleep)
        # _ChoiceClient still builds and validates real request/response payloads.
        # Only its network boundary is replaced, before clients share the opener.
        self.classifier._opener = self
        clients = (self.classifier, EventMatcher(shared=self.classifier),
                   TopicMatcher(shared=self.classifier), Analyzer(shared=self.classifier),
                   ToneClient(shared=self.classifier))
        methods = ('classify', 'match', 'match', 'analyze', 'tone')
        for lane, client, method in zip(LANES, clients, methods):
            original = getattr(client, method)
            setattr(client, method, self.wrap(lane, original))
        feeds = [{'name': name, 'url': name} for name in ('甲', '乙', '丙')]
        self.scheduler = Scheduler(feeds, FunctionFetcher(self.fetch), Sink(), 1,
            classifier=clients[0], matcher=clients[1], topic_matcher=clients[2],
            analyzer=clients[3], tone_client=clients[4], interval=3600,
            log=self.logs.append)

    def snapshot(self, version):
        # Three outlets seed one event. A separate event shares a rare topic
        # feature, so real topic planning (not a patched plan) reaches that lane.
        records = [(i, '跨海和平峰會合作協議進展', name)
                   for i, name in enumerate(('甲', '乙', '丙'))]
        records.append((3, '跨海和平峰會談判各方反應新消息', '甲'))
        # Distinct CJK alphabets keep unrelated filler pairs below the threshold.
        for i in range(4, 47):
            if version and i % (7 + version) == 0:
                continue
            title = ''.join(chr(0x5000 + i * 20 + j) for j in range(12))
            records.append((i, title, ('甲', '乙', '丙')[i % 3]))
        if version:
            records.append((50 + version, '跨海和平峰會合作協議進展', '乙'))
        if version == 3:
            # A fresh candidate cannot inherit earlier event-match cache entries.
            # Share a rare topic word, but keep bigram overlap below the event
            # candidate threshold so the random pair answer cannot swallow it.
            records.append((90, '跨海' + ''.join(chr(0x9000 + j) for j in range(20)), '甲'))
            # Keep that feature below 10% even after refresh removes old fillers.
            records.extend((i, ''.join(chr(0x7000 + i * 20 + j) for j in range(12)),
                            ('甲', '乙', '丙')[i % 3]) for i in range(60, 80))
        self.rng.shuffle(records)
        return records

    def fetch(self, source, _):
        with self.lock:
            snapshot = list(self.current)
        rows = ''.join('<item><title>' + escape(title) + '</title><link>https://example.com/'
                       + str(key) + '</link><pubDate>Sat, 26 Sep 2026 00:00:00 GMT</pubDate>'
                       + '<description>摘要</description></item>'
                       for key, title, name in snapshot if name == source)
        return Result('ok', ('<rss><channel>' + rows + '</channel></rss>').encode(),
                      'https://example.com/feed', {})

    def wrap(self, lane, original):
        def request(batch, **kwargs):
            keys = [item.key if lane in ('events', 'topics') else item[0] for item in batch]
            tokens = {(lane, key) for key in keys}
            with self.lock:
                call = self.calls[lane]
                self.calls[lane] += 1
                rng = random.Random(self.seed * 100003 + LANES.index(lane) * 1009 + call)
                delay = rng.uniform(0, .03)
                fail = not self.clean and rng.random() < .18
                # Spread forced first-call outcomes across seeds, while later
                # calls independently inject failures in any of the five lanes.
                auth = not self.clean and lane == 'classify' and call == 0 and self.seed % 10 == 0
                if lane == 'classify' and call == 0 and self.seed % 3 == 1:
                    fail = True
                limited = not self.clean and (rng.random() < .25 or call == 0)
                overlaps = self.active & tokens
                if overlaps:
                    self.duplicates.append((lane, tuple(map(str, overlaps))))
                self.active.update(tokens)
                self.trace.append((lane, call, 'auth' if auth else 'fail' if fail else 'ok', limited))
            self.local.plan = dict(lane=lane, delay=delay, fail=fail, auth=auth,
                                   limited=limited, attempt=0, same=rng.random() < .35)
            self.entered.set()
            try:
                return original(batch, **kwargs)
            finally:
                with self.lock:
                    self.active.difference_update(tokens)
        return request

    def retry_sleep(self, delay):
        # Exercise real _ChoiceClient retry admission without spending 0.5s
        # per synthetic 429; scheduling delays are injected separately below.
        with self.lock:
            self.outcomes['backoff'] += 1
        if delay not in (.5, 1):
            raise AssertionError(f'unexpected retry delay {delay}')

    def open(self, request, timeout):
        plan = self.local.plan
        time.sleep(plan['delay'])
        plan['attempt'] += 1
        if plan['limited'] and plan['attempt'] == 1:
            code = 429
        elif plan['auth']:
            code = 401
        elif plan['fail']:
            code = 500
        else:
            code = 200
        with self.lock:
            self.outcomes[code] += 1
            if code == 401:
                self.auth = True
        if code != 200:
            return Response(code, {})
        payload = json.loads(request.data)
        answers = {}
        for name, question in payload['questions'].items():
            criteria = question['criteria']
            choice = ('world' if 'world' in criteria else
                      ('same' if plan['same'] else 'different') if 'same' in criteria else
                      'same_topic' if 'same_topic' in criteria else
                      'neutral' if 'neutral' in criteria else
                      'other')
            answers[name] = {'choice': choice, 'probabilities': {choice: .95}}
            if plan['lane'] == 'events':
                with self.lock:
                    self.outcomes[choice] += 1
        return Response(200, {'answers': answers})

    def settled(self):
        s = self.scheduler
        with s.cv:
            return (s.last_list is not None and not s.active and not s.pending_refresh
                    and not s.results and not any(lane.jobs.qsize() for lane in s.lanes)
                    and not any(self.in_flight()) and not s.model_rounds)

    def in_flight(self):
        s = self.scheduler
        return (s.in_flight, s.analysis_in_flight, s.event_in_flight,
                s.topic_in_flight, s.tone_in_flight)

    def run(self):
        s = self.scheduler
        try:
            s.start()
            if not self.entered.wait(2):
                raise AssertionError('no model request started')
            for version in (1, 2):
                time.sleep(self.rng.uniform(0, .025))
                with self.lock:
                    self.current = self.snapshots[version]
                s.refresh()
                if self.rng.random() < .5:
                    s.refresh()  # Coalesced refresh while another round is active.
            eventually(self.settled, timeout=4)
            with self.lock:
                self.clean = True
                self.current = self.snapshots[3]
            with s.cv:
                previous_round = s.round_id
            s.refresh()
            # Idle queues can precede the coordinator's out-of-lock _send_list.
            # Wait for the actual terminal list as well, not that transient gap.
            expected = {'state': 'off', 'reason': 'auth'} if self.auth else {'state': 'done', 'reason': ''}
            eventually(lambda: s.round_id > previous_round and self.settled()
                       and s.last_list['body']['model'] == expected
                       and len(s.last_list['body']['items']) == len(self.snapshots[3]), timeout=4)
            with s.cv:
                assert not any(self.in_flight()), 'in_flight leaked'
                assert all(lane.jobs.empty() for lane in s.lanes), 'queued work leaked'
                body = deepcopy(s.last_list['body'])
            expected = {'state': 'off', 'reason': 'auth'} if self.auth else {'state': 'done', 'reason': ''}
            assert body['model'] == expected, body['model']
            assert all(body[name]['pending'] == 0 for name in ('classify', 'analysis', 'events', 'topics')), body
            assert body['topics']['tone_pending'] == 0, body['topics']
            if not self.auth:
                assert self.calls['topics'] > 0, 'clean round never exercised topics'
                assert any(item['link'].endswith('/90') and item.get('topic')
                           for item in body['items']), 'fresh topic candidate never joined'
            assert not self.duplicates, self.duplicates
            assert not self.active, self.active
            assert len(body['items']) == len(self.snapshots[3]), 'clean snapshot not emitted'
            assert any(item['event_size'] >= 3 for item in body['items']), 'no event merging exercised'
            rounds = [line.split()[1] for line in self.logs if line.startswith('model round=')]
            assert rounds and len(rounds) == len(set(rounds)), rounds
            return self.calls, self.outcomes
        except Exception as exc:
            raise AssertionError(f'seed={self.seed} index={self.index} trace={self.trace}: {exc}') from exc
        finally:
            s.stop()
            for worker in s.workers + s.classify_workers + [s.coordinator]:
                if worker.ident is not None:
                    worker.join(2)
                    if worker.is_alive():
                        raise AssertionError(f'seed={self.seed}: stop leaked {worker.name}')


class ModelChaosTests(unittest.TestCase):
    def test_seeded_fault_sequences_converge_and_release_all_work(self):
        count = int(os.environ.get('NEWS_CHAOS_CASES', '60'))
        seed = int(os.environ.get('NEWS_CHAOS_SEED', '47000'))
        self.assertGreater(count, 0)
        calls, outcomes = Counter(), Counter()
        # Independent scenarios run concurrently to keep the default suite
        # increment below 10s even with real 0..30ms response delays.
        with ThreadPoolExecutor(max_workers=4) as pool:
            pending = {pool.submit(Scenario(seed + i, i).run): seed + i for i in range(count)}
            for future in as_completed(pending):
                with self.subTest(seed=pending[future]):
                    lane_calls, codes = future.result()
                    calls.update(lane_calls)
                    outcomes.update(codes)
        if count >= 60:
            self.assertEqual(set(calls), set(LANES))
            for outcome in (200, 401, 429, 500, 'backoff', 'same', 'different'):
                self.assertGreater(outcomes[outcome], 0, (outcome, outcomes))
