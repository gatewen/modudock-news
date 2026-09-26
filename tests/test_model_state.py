from copy import deepcopy
import unittest

from back.feedparse import fit_packet, packet_bytes, MAX_PACKET
from tests import test_tone_scheduler as helpers
from tests.test_topics import snapshot, story, response
from tests.test_tone import tone_response
from tests.test_classify import server
from tests.test_scheduler import eventually


class ModelStateTests(unittest.TestCase):
    setUp = helpers.ToneSchedulerTests.setUp
    tearDown = helpers.ToneSchedulerTests.tearDown
    make = helpers.ToneSchedulerTests.make

    def test_403_pauses_but_refresh_recovers_and_circuit_drains_without_http(self):
        for failures in (2, 3):
            with self.subTest(failures=failures):
                now = [0]
                def respond(payload, number, _):
                    if s.round_id <= failures: return 403, b'PRIVATE RBAC', {}
                    return tone_response(payload) if 'q_0' in payload['questions'] else response(payload)
                with server(respond) as (url, received):
                    s, sink = self.make(url, snapshot([story('one', 'ALPHA')])[0])
                    s.classifier.clock = lambda: now[0]
                    for client in (s.analyzer, s.matcher, s.topic_matcher, s.tone_client):
                        client.clock = s.classifier.clock
                    s.start()
                    count = 0
                    for rid in range(1, failures + 1):
                        eventually(lambda: s.last_list is not None and s.last_list['body']['model'] ==
                                   {'state':'paused','reason':'failed','failure':'service'})
                        eventually(lambda: not any((s.in_flight, s.analysis_in_flight, s.event_in_flight,
                                                    s.topic_in_flight, s.tone_in_flight)))
                        self.assertTrue(s.classifier.enabled)
                        self.assertGreater(len(received), count)
                        self.assertLessEqual(len(received) - count, 3)
                        count = len(received)
                        self.assertEqual(s.classifier._state.service_failures, rid)
                        if rid < failures:
                            s.refresh()
                            eventually(lambda: s.completed >= rid + 1)
                    if failures == 3:
                        for rid in (4, 5):
                            s.refresh()
                            eventually(lambda: s.completed >= rid)
                            eventually(lambda: s.last_list['body']['model']['state'] == 'paused')
                            eventually(lambda: not any((s.in_flight, s.analysis_in_flight, s.event_in_flight,
                                                        s.topic_in_flight, s.tone_in_flight)))
                            self.assertEqual(len(received), count)
                            self.assertTrue(all(lane.jobs.empty() for lane in s.lanes))
                        now[0] = 1800
                    s.refresh()
                    eventually(lambda: s.last_list['body']['model']['state'] == 'done', timeout=3)
                    self.assertEqual(s.classifier._state.service_failures, 0)
                    self.assertGreater(len(received), failures)
                    s.stop()

    def test_failed_and_budget_rounds_pause_then_refresh_finishes(self):
        for reason in ['failed', 'budget']:
            with self.subTest(reason=reason):
                now, first = [0], [True]
                def respond(payload, *_):
                    if first[0]:
                        first[0] = False
                        if reason == 'failed':
                            return 500, b'PRIVATE FAILURE CONTENT', {}
                        now[0] = 61
                    return tone_response(payload) if 'q_0' in payload['questions'] else response(payload)
                with server(respond) as (url, _):
                    s, sink = self.make(url, snapshot([story('one', 'ALPHA BETA'), story('two', 'BETA DELTA')])[0])
                    s.model_clock = lambda: now[0]
                    s.start()
                    initial = sink.packets.get(timeout=2)
                    self.assertEqual(initial['body']['model'], {'state':'working','reason':''})
                    eventually(lambda: s.last_list is not None and s.last_list['body']['model'].get('state') == 'paused' and s.last_list['body']['model'].get('reason') == reason, timeout=3)
                    self.assertEqual(s.last_list['body']['model']['reason'], reason)
                    self.assertEqual(s.last_list['body']['at'], initial['body']['at'])
                    eventually(lambda: not (s.topic_in_flight or s.tone_in_flight))
                    while not sink.packets.empty(): sink.packets.get_nowait()
                    s.refresh()
                    # An acknowledged old result may still be serializing a
                    # resend. The new round's publish fences its initial list.
                    while True:
                        packet = sink.packets.get(timeout=3)
                        if packet['t'] == 'publish':
                            break
                        current = packet
                    self.assertEqual(current['body']['model']['state'], 'working')
                    eventually(lambda: s.completed == 2 and s.last_list['body']['model']['state'] == 'done', timeout=3)
                    states = [current['body']['model']['state']]
                    while not sink.packets.empty():
                        packet = sink.packets.get_nowait()
                        if packet['t'] == 'msg': states.append(packet['body']['model']['state'])
                    self.assertEqual(states[0], 'working')
                    self.assertEqual(states[-1], 'done')
                    self.assertEqual(s.last_list['body']['model']['reason'], '')
                    s.stop()

    def test_disabled_overrides_zero_pending_and_empty_enabled_list_is_done(self):
        s, _ = self.make('http://unused.invalid', snapshot()[0])
        for cache in s.caches: cache.items = []
        self.assertEqual(s._emit(s.caches, [])['body']['model'], {'state':'done','reason':''})
        s.classifier.enabled = False
        self.assertEqual(s._emit(s.caches, [])['body']['model'], {'state':'off','reason':'auth'})

    def test_model_state_size_is_reserved_before_longer_status_resend(self):
        packet = {'t':'msg','body':{'items':[{'title':'x'*100} for _ in range(20)],
                                  'model':{'state':'done','reason':''}}}
        packet['body']['padding'] = 'x' * (MAX_PACKET - len(packet_bytes(packet)))
        initial = fit_packet(packet)
        self.assertLess(len(initial['body']['items']), 20)
        for state, reason in [('working',''),('paused','failed'),('paused','budget'),('paused','waiting'),('off','no_key'),('off','auth')]:
            changed = deepcopy(initial)
            changed['body']['model'] = {'state':state,'reason':reason}
            if reason == 'failed': changed['body']['model']['failure'] = 'connection'
            self.assertLessEqual(len(packet_bytes(changed)),MAX_PACKET)
            self.assertEqual(fit_packet(changed)['body']['items'],initial['body']['items'])

    def test_failure_details_are_safe_codes_from_transport_and_validation(self):
        from back.classify import Classifier
        from back.scheduler import Scheduler, ModelRound
        for mode, expected in [('403','service'),('429','busy'),('529','busy'),('timeout','connection'),
                               ('json','response'),('answers','response'),('500','other')]:
            with self.subTest(mode=mode):
                def respond(payload, _number, release):
                    if mode == 'timeout': release.wait(.1)
                    if mode in ('403','429','529','500'): return int(mode),b'SECRET-URL-KEY',{}
                    return 200,(b'not json SECRET-URL-KEY' if mode == 'json' else {'answers':{}}),{}
                with server(respond) as (url, received):
                    logs=[]
                    client=Classifier(endpoint=url,key='SECRET-URL-KEY',timeout=.02 if mode=='timeout' else 1,
                                      sleep=lambda _:None,log=logs.append)
                    s=Scheduler([{'name':'A','url':'unused'}],None,None,1,classifier=client,log=logs.append)
                    work=ModelRound(1);s.model_work=work
                    s.classify_jobs.put((work,('key','title','')))
                    def submit(result):
                        with s.cv: s._accept(result)
                        return False
                    s._submit_classification=submit;s._classify_worker()
                    state=s._model_state({'classify':{'pending':1}})
                    self.assertEqual(state,{'state':'paused','reason':'failed','failure':expected})
                    self.assertNotIn('SECRET-URL-KEY',str(state)+'\n'.join(logs))
                    self.assertNotIn(url,str(state)+'\n'.join(logs))
                    if mode in ('429','529'): self.assertEqual(len(received),3)
                    s.stop()

    def test_failure_detail_reserve_at_packet_boundary_with_tiny_items(self):
        packet={'t':'msg','body':{'items':[{} for _ in range(100)],'model':{'state':'done','reason':''}}}
        packet['body']['padding']='x'*(MAX_PACKET-len(packet_bytes(packet)))
        initial=fit_packet(packet)
        for detail in ('busy','connection','response','service','other'):
            changed=deepcopy(initial)
            changed['body']['model']={'state':'paused','reason':'failed','failure':detail}
            self.assertLessEqual(len(packet_bytes(changed)),MAX_PACKET)
            self.assertEqual(len(fit_packet(changed)['body']['items']),len(initial['body']['items']))
