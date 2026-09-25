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
                    eventually(lambda: s.last_list is not None and s.last_list['body']['model']['state'] == 'paused', timeout=3)
                    self.assertEqual(s.last_list['body']['model']['reason'], reason)
                    self.assertEqual(s.last_list['body']['at'], initial['body']['at'])
                    eventually(lambda: not (s.topic_in_flight or s.tone_in_flight))
                    while not sink.packets.empty(): sink.packets.get_nowait()
                    s.refresh()
                    eventually(lambda: s.completed == 2 and s.last_list['body']['model']['state'] == 'done', timeout=3)
                    states = []
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
        self.assertEqual(s._emit(s.caches, [])['body']['model'], {'state':'off','reason':'disabled'})

    def test_model_state_size_is_reserved_before_longer_status_resend(self):
        packet = {'t':'msg','body':{'items':[{'title':'x'*100} for _ in range(20)],
                                  'model':{'state':'done','reason':''}}}
        packet['body']['padding'] = 'x' * (MAX_PACKET - len(packet_bytes(packet)))
        initial = fit_packet(packet)
        self.assertLess(len(initial['body']['items']), 20)
        for state, reason in [('working',''),('paused','failed'),('paused','budget'),('off','disabled')]:
            changed = deepcopy(initial)
            changed['body']['model'] = {'state':state,'reason':reason}
            self.assertLessEqual(len(packet_bytes(changed)),MAX_PACKET)
            self.assertEqual(fit_packet(changed)['body']['items'],initial['body']['items'])
