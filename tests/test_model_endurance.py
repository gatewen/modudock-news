"""Bounded multi-round scheduler stress. Real parsing/protocol, in-memory HTTP only."""
from collections import Counter
from datetime import datetime, timezone
import json
import threading
import time
import unittest
from unittest.mock import patch
from xml.sax.saxutils import escape

from back.analyze import Analyzer
from back.classify import Classifier
from back.events import EventMatcher
from back.fetch import Result
from back.scheduler import Scheduler
from back.topics import TopicMatcher, ToneClient
from tests.test_model_chaos import Response


class BudgetResponse(Response):
    def __init__(self, body, expire):
        super().__init__(200, body)
        self.expire = expire

    def __exit__(self, *args):
        result = super().__exit__(*args)
        # Expire after a valid response has been fully read, so this is model
        # budget exhaustion, not another transport/read timeout.
        self.expire()
        return result


class Endurance:
    def __init__(self, ring=120):
        self.ring = ring
        self.step = 0
        self.lock = threading.Lock()
        self.signal = threading.Event()
        self.release = threading.Event()
        self.entered = threading.Event()
        self.mode = 'ok'
        self.injected = False
        self.offset = 0
        self.http = Counter()
        self.logs = Counter()
        self.states = Counter()
        self.reasons = Counter()
        self.topics_seen = set()
        self.peak = Counter()
        self.thread_ids = None
        self.last = None
        self.hold = False
        self.client = Classifier(key='endurance-fake', clock=self.clock,
                                 log=self.log, sleep=lambda _: None)
        self.client._opener = self
        self.s = Scheduler(
            [{'name': n, 'url': n} for n in 'ABC'], self, self, 1,
            classifier=self.client, matcher=EventMatcher(shared=self.client),
            topic_matcher=TopicMatcher(shared=self.client),
            analyzer=Analyzer(shared=self.client), tone_client=ToneClient(shared=self.client),
            interval=36000, now=lambda: datetime(2026, 9, 26, tzinfo=timezone.utc),
            log=self.log)

    def clock(self):
        return time.monotonic() + self.offset

    def log(self, line):
        # Never accumulate log lines or packets in the harness.
        self.logs[line.split()[0]] += 1
        self.signal.set()

    def put(self, packet):
        if packet.get('body', {}).get('op') == 'list':
            self.last = packet
            body = packet['body']
            self.states[body['model']['state']] += 1
            self.reasons[body['model']['reason']] += 1
            self.topics_seen.add(bool(body['topics']['list']))
        self.signal.set()
        return True

    def fetch(self, source, _):
        step = self.step
        epoch = (step - 1 if step % 5 == 0 else step) % self.ring
        rows = []
        for i in range(48):
            if 'ABC'[i % 3] != source:
                continue
            if i < 3 and step % 7 != 0:
                title = '和平峰會合作協議 ALPHA BETA GAMMA DELTA EPSILON'
            elif 3 <= i < 8 and step % 7 != 0:
                title = ['ALPHA', 'BETA', 'GAMMA', 'DELTA', 'EPSILON'][i-3] + ''.join(chr(0x6000+i*20+j) for j in range(12))
            else:
                title = ''.join(chr(0x5000+i*20+j) for j in range(12))
            rows.append(f'<item><title>{escape(title)}</title><link>https://example.com/{epoch}/{i}</link><description>摘要</description></item>')
        return Result('ok', ('<rss><channel>'+''.join(rows)+'</channel></rss>').encode(),
                      'https://example.com/feed', {})

    def open(self, request, timeout):
        with self.lock:
            mode = self.mode if not self.injected else 'ok'
            self.injected = True
            hold = self.hold
            self.hold = False
        if hold:
            self.entered.set()
            if not self.release.wait(5):
                raise AssertionError('overlap gate not released')
        self.http[mode] += 1
        if mode in ('429', '529'):
            return Response(int(mode), {})
        if mode == 'bad':
            return Response(200, {'answers': {}})
        if mode == 'timeout':
            raise TimeoutError('synthetic')
        payload = json.loads(request.data)
        answers = {}
        for name, question in payload['questions'].items():
            criteria = question['criteria']
            choice = ('world' if 'world' in criteria else 'different' if 'same' in criteria
                      else 'same_topic' if 'same_topic' in criteria
                      else 'neutral' if 'neutral' in criteria else 'other')
            answers[name] = {'choice': choice, 'probabilities': {choice: .95}}
        if mode == 'budget':
            return BudgetResponse({'answers': answers}, self.expire_budget)
        return Response(200, {'answers': answers})

    def expire_budget(self):
        self.offset += 61

    def measure(self):
        s = self.s
        with s.cv:
            result = {
                'caches': len(s.caches), 'source_items': max(len(c.items) for c in s.caches),
                'first_seen': max(len(c.first_seen) for c in s.caches),
                'event_cache': len(s.event_cache), 'topic_cache': len(s.topic_cache),
                'tone_cache': len(s.tone_cache), 'classify_cache': len(s.classify_cache),
                'analysis_cache': len(s.analysis_cache), 'model_rounds': len(s.model_rounds),
                'results': len(s.results), 'fetch_jobs': s.jobs.qsize(),
                'last_topic_seeds': len(s.last_topic_seeds),
                'candidate_keys': len(s._event_candidate_keys),
                'candidate_items': len((s._event_candidates_list or {}).get('body', {}).get('items', [])),
                'last_items': len((s.last_list or {}).get('body', {}).get('items', [])),
            }
            for lane, attr in [('classify','in_flight'), ('analysis','analysis_in_flight'),
                               ('events','event_in_flight'), ('topics','topic_in_flight'),
                               ('tone','tone_in_flight')]:
                result[lane+'_in_flight'] = len(getattr(s, attr))
            for lane in s.lanes:
                result[lane.name+'_jobs'] = lane.jobs.qsize()
            result['active_threads'] = threading.active_count()
            result['model_workers'] = sum(w.is_alive() for w in s.classify_workers)
            result['owned_threads'] = sum(w.is_alive() for w in self.threads())
            return result

    def check(self, idle=False):
        m = self.measure()
        caps = {'caches':3,'source_items':60,'first_seen':1000,'event_cache':20000,
                'topic_cache':20000,'tone_cache':4000,'classify_cache':4000,
                'analysis_cache':4000,'last_topic_seeds':5,'candidate_items':300,
                'candidate_keys':44850,'last_items':300,'results':32,'fetch_jobs':32,
                'model_rounds':3, 'classify_in_flight':360, 'analysis_in_flight':360,
                'tone_in_flight':360, 'events_in_flight':720, 'topics_in_flight':357}
        for name,value in m.items():
            if name in caps:
                assert value <= caps[name], (name,value,caps[name])
            if name.endswith('_jobs'):
                assert value <= (600 if name=='events_jobs' else 32 if name=='fetch_jobs' else 300),(name,value)
            if idle and (name.endswith('_jobs') or name.endswith('_in_flight') or name in ('results','model_rounds')):
                assert value == 0,(name,value)
            self.peak[name] = max(self.peak[name],value)
        assert m['owned_threads']==8 and m['model_workers']==3,m
        ids=tuple(w.ident for w in self.threads())
        if self.thread_ids is None:
            self.thread_ids=ids
        assert ids==self.thread_ids,'workers recreated'
        return m

    def settled(self, after):
        s=self.s
        with s.cv:
            return (s.completed > after and not s.active and not s.pending_refresh
                    and not s.results and not s.model_rounds and s.jobs.empty()
                    and all(lane.jobs.empty() for lane in s.lanes)
                    and not any((s.in_flight,s.analysis_in_flight,s.event_in_flight,s.topic_in_flight,s.tone_in_flight))
                    and self.last is not None and self.last['body']['model']['state']!='working')

    def wait(self, after):
        deadline=time.monotonic()+5
        while True:
            self.signal.clear()
            self.check()
            if self.settled(after):
                self.check(idle=True)
                return
            if time.monotonic()>deadline:
                raise AssertionError(('not idle',self.measure()))
            # Signals come from accepted packets/logs; final cleanup may follow
            # the last signal, so periodically recheck under the coordinator lock.
            self.signal.wait(.01)

    def threads(self):
        return self.s.workers+self.s.classify_workers+[self.s.coordinator]

    def run(self, rounds, sample=None):
        # A regression cannot silently escape the fake network boundary.
        with patch('socket.socket.connect', side_effect=AssertionError('network forbidden')):
            try:
                self.s.start()
                self.wait(0)
                for step in range(1,rounds+1):
                    self.step=step
                    self.mode=('ok','429','529','bad','timeout','budget')[step%6]
                    self.injected=False
                    # Gate a fresh request to guarantee refresh overlaps in-flight
                    # model work, instead of relying on scheduling or sleep.
                    hold=step%12==1 and step%5!=0 and step<self.ring
                    self.hold=hold
                    self.entered.clear();self.release.clear()
                    before=self.s.completed
                    self.s.refresh()
                    if hold:
                        if not self.entered.wait(5):raise AssertionError('no overlap request')
                        self.check()
                        self.s.refresh()
                        self.release.set()
                    self.wait(before)
                    if sample:sample(step,self.check(idle=True))
                assert all(self.http[k] for k in ('429','529','bad','timeout','budget')),self.http
                assert self.topics_seen=={False,True},self.topics_seen
                assert self.reasons['budget'] and self.reasons['failed'], self.reasons
                return self.check(idle=True)
            finally:
                self.release.set()
                self.s.stop()
                for w in self.threads():
                    w.join(5)
                    assert not w.is_alive(),w.name


class ModelEnduranceTests(unittest.TestCase):
    def test_200_rounds_bound_resources_and_release_idle_work(self):
        Endurance().run(200)
