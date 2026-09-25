import unittest

from back.topics import ToneClient, TONE_CRITERIA
from tests.test_classify import items, server


def tone_response(payload, *_):
    return 200, {'answers':{q:{'choice':'negative','probabilities':{'negative':.9}} for q in payload['questions']}}, {}


class ToneClientTests(unittest.TestCase):
    def test_exact_questions_and_state(self):
        with server(tone_response) as (url, received):
            result = ToneClient(endpoint=url, key='test').tone(items())
        self.assertEqual(result, {'private-key-0':'negative','private-key-1':'negative'})
        payload = received[0][2]
        self.assertEqual(set(payload['state']), {'news_0','news_1'})
        self.assertEqual(TONE_CRITERIA, {'positive':'正面：強調成果、進展、合作或利多',
            'negative':'負面：強調分歧、受挫、風險、抗議或批評', 'neutral':'中性：主要陳述事實、行程或背景', 'mixed':'正反並陳'})
        self.assertEqual(payload['questions'], {f'q_{i}':{'type':'choice','criteria':TONE_CRITERIA,
            'instructions':f'news_{i} 對它所報導的事情，整體評價基調是什麼？'} for i in range(2)})

    def test_abstain_threshold_and_atomic_invalid_answer(self):
        for probability, expected in [(.34,'neutral'), (.35,'negative')]:
            with server(lambda *_:(200, {'answers':{'q_0':{'choice':'negative','probabilities':{'negative':probability}}}}, {})) as (url, _):
                self.assertEqual(ToneClient(endpoint=url, key='test').tone(items(1)), {'private-key-0':expected})
        with server(lambda *_:(200, {'answers':{'q_0':{'choice':'negative','probabilities':{'negative':.9}},'q_1':{}}}, {})) as (url, _):
            self.assertIsNone(ToneClient(endpoint=url, key='test', log=lambda _:None).tone(items()))

    def test_batch_limits_and_failure_stops_round(self):
        with server(tone_response) as (url, received):
            client = ToneClient(endpoint=url, key='test')
            self.assertEqual([len(r) for r in client.tone_round(items(41))], [20,20,1])
            self.assertEqual([len(r) for r in client.tone_round(items(3, title='x'*4000, summary=''))], [2,1])
        with server(lambda *_:(500,b'',{})) as (url, received):
            self.assertEqual(list(ToneClient(endpoint=url, key='test', log=lambda _:None).tone_round(items(41))), [])
            self.assertEqual(len(received), 1)
