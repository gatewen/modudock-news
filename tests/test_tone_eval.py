import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

from back.classify import _http_observer
from back.topics import ToneClient
from scripts.tone_eval import evaluate, load_data, main, metric, planned_batches


class FakeClient(ToneClient):
    def __init__(self, answers=None, retries=0, fail=False):
        super().__init__(key='fake', log=lambda _: None)
        self.answers = answers or {}
        self.batches = []
        self.retries = retries
        self.fail = fail

    def tone(self, batch):
        self.batches.append(batch)
        for attempt in range(self.retries + 1):
            _http_observer.get()(attempt > 0)
        if self.fail:
            return None
        return {key: self.answers.get(key, 'neutral') for key, _, _ in batch}


def data(n=3):
    items = {str(i): dict(link=str(i), topic_title='topic', title='title', summary='summary', source='s') for i in range(n)}
    a = {k: dict(link=k, label='neutral', confidence='high') for k in items}
    return items, a, {k: dict(v) for k, v in a.items()}


class ToneEvalTests(unittest.TestCase):
    def test_metrics_flips_matrix_and_missing_denominator(self):
        result = metric({'a': 'negative', 'b': 'neutral'}, {'a': 'positive', 'b': 'neutral', 'c': 'mixed'})
        self.assertEqual((result['correct'], result['missing'], result['polarity_flips']), (1, 1, 1))
        self.assertEqual(result['agreement'], 1/3)
        self.assertEqual(result['confusion']['positive']['negative'], 1)
        self.assertIsNone(metric({}, {})['agreement'])

    def test_consensus_and_high_disagreement(self):
        items, a, b = data()
        a['0']['label'] = 'positive'
        b['0']['label'] = 'negative'
        a['1']['confidence'] = 'low'
        result = evaluate(items, a, b, client=FakeClient())['runs'][0]['metrics']
        self.assertEqual(result['annotator_a']['correct'], 2)
        self.assertEqual(result['consensus']['total'], 2)
        self.assertEqual(result['both_high_a']['total'], 2)
        self.assertEqual(result['both_high_consensus']['total'], 1)

    def test_production_batching_by_topic_and_characters(self):
        items, a, b = data(23)
        items['21']['topic_title'] = 'other'
        items['22']['topic_title'] = 'other'
        items['21']['summary'] = 'x' * 5000
        items['22']['summary'] = 'x' * 5000
        client = FakeClient()
        result = evaluate(items, a, b, client=client)
        self.assertEqual([len(batch) for batch in client.batches], [20, 1, 1, 1])
        self.assertEqual(result['http'], 4)
        self.assertEqual(planned_batches(items)[1], 4)
        self.assertIn('news_0', client._questions(1)['q_0']['instructions'])
        self.assertNotIn('topic', client._questions(1)['q_0']['instructions'])

    def test_http_cap_retries_and_context_restored(self):
        items, a, b = data()
        previous = _http_observer.get()
        result = evaluate(items, a, b, client=FakeClient(retries=2), runs=2, max_http=4)
        self.assertEqual((result['http'], result['retries']), (4, 2))
        self.assertFalse(result['complete'])
        self.assertEqual(result['runs'][1]['metrics']['consensus']['missing'], 3)
        self.assertIs(_http_observer.get(), previous)

    def test_failure_stops_and_reports_missing(self):
        items, a, b = data()
        result = evaluate(items, a, b, client=FakeClient(fail=True), runs=3)
        self.assertFalse(result['complete'])
        self.assertEqual(len(result['runs']), 1)
        self.assertEqual(result['stability']['eligible'], 0)

    def test_stability_repeats_without_cache(self):
        items, a, b = data()
        client = FakeClient()
        original = client.tone
        def changing(batch):
            client.answers = {'0': 'positive'} if client.batches else {}
            return original(batch)
        client.tone = changing
        result = evaluate(items, a, b, client=client, runs=3)
        self.assertEqual(result['http'], 3)
        self.assertEqual(result['stability']['consistent'], 2)
        self.assertEqual(result['stability']['agreement'], 2/3)

    def test_external_validation_and_cli(self):
        items, a, b = data()
        with tempfile.TemporaryDirectory() as directory:
            paths = [Path(directory)/name for name in ('input.json', 'a.json', 'b.json')]
            for path, rows in zip(paths, (items, a, b)):
                path.write_text(json.dumps(list(rows.values())))
            self.assertEqual(load_data(*paths), (items, a, b))
            argv = ['--input', str(paths[0]), '--gold', str(paths[1]), '--gold-b', str(paths[2])]
            factory = Mock(return_value=FakeClient())
            with contextlib.redirect_stdout(io.StringIO()) as stdout:
                self.assertEqual(main(argv+['--dry-run'], factory), 0)
                factory.assert_not_called()
                self.assertEqual(main(argv, factory), 0)
            self.assertNotIn('summary', stdout.getvalue())
            rows = list(a.values())
            paths[1].write_text(json.dumps(rows + rows[:1]))
            with self.assertRaisesRegex(ValueError, '重複'):
                load_data(*paths)
            paths[1].write_text(json.dumps(rows[:-1]))
            with self.assertRaisesRegex(ValueError, '集合'):
                load_data(*paths)
            paths[1].write_text(json.dumps([dict(row, label='bad') for row in rows]))
            with self.assertRaisesRegex(ValueError, '標籤'):
                load_data(*paths)

    def test_disabled_cli_does_not_send(self):
        from unittest.mock import patch
        items, a, b = data()
        client = FakeClient()
        client.enabled = False
        with patch('scripts.tone_eval.load_data', return_value=(items, a, b)):
            with contextlib.redirect_stderr(io.StringIO()) as stderr:
                self.assertEqual(main([], lambda: client), 2)
        self.assertEqual(client.batches, [])
        self.assertIn('TYPESAFE_API_KEY', stderr.getvalue())

    def test_unexpected_exception_restores_observer(self):
        items, a, b = data()
        client = FakeClient()
        client.tone = Mock(side_effect=RuntimeError('test'))
        previous = _http_observer.get()
        with self.assertRaises(RuntimeError):
            evaluate(items, a, b, client=client)
        self.assertIs(_http_observer.get(), previous)

    def test_missing_files_no_network(self):
        factory = Mock()
        with contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(main(['--input', '/nonexistent/tone-input.json'], factory), 2)
        factory.assert_not_called()
        self.assertIn('--input', stderr.getvalue())
