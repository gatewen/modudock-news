import json
import os
from pathlib import Path
import ssl
import time
import unittest
from unittest.mock import patch

from back.analyze import Analyzer
from back.classify import MAX_BODY
from back.fetch import USER_AGENT
from tests.test_classify import server, items


def answers(n=2):
    return {"answers": {f"{name}_{i}": {"choice": choice, "probabilities": {choice: 0.8}}
                        for i in range(n) for name, choice in
                        (("market", "positive"), ("theme", "memory"), ("dir", "bull"))}}


class AnalyzeTests(unittest.TestCase):
    def client(self, url, **kwargs):
        return Analyzer(endpoint=url, key="analysis-secret", log=lambda _: None, **kwargs)

    def test_request_shape_and_exact_spec_questions(self):
        # Read the normative table independently of implementation constants.
        spec = (Path(__file__).resolve().parents[1] / "docs/SPEC.md").read_text()
        section = spec.split("### 13.3 ", 1)[1].split("### 13.4", 1)[0]
        expected_criteria = {}
        for name in ("market", "theme", "dir"):
            part = section.split(f'- `{name}`：', 1)[1].split('\n- ', 1)[0]
            expected_criteria[name] = {}
            for line in part.splitlines():
                cells = [c.strip() for c in line.strip().strip('|').split('|')]
                if line.strip().startswith('| `'):
                    expected_criteria[name][cells[0].strip('`')] = cells[-1]
        instructions = {
            "market": "這則報導對股市前景呈現什麼方向的訊息？",
            "theme": "這則新聞最主要涉及哪個產業或題材？",
            "dir": "這則新聞對它最主要涉及的產業或個股，呈現什麼方向？",
        }
        with server(lambda p, *_: (200, answers(len(p["state"])), {})) as (url, received):
            result = self.client(url).analyze(items())
        self.assertEqual(result, {f"private-key-{i}": {"kind": "finance", "market": "positive", "theme": "memory", "dir": "bull", "dir_p": 0.8} for i in range(2)})
        _, headers, payload = received[0]
        headers = {k.lower(): v for k, v in headers.items()}
        self.assertEqual(headers["authorization"], "Bearer analysis-secret")
        self.assertEqual(headers["content-type"], "application/json")
        self.assertEqual(headers["user-agent"], USER_AGENT)
        self.assertEqual(set(payload), {"model", "state", "questions"})
        self.assertEqual(payload["model"], "jev-1.13.0")
        self.assertEqual(payload["state"], {f"news_{i}": {"title": "標題", "summary": "摘要"} for i in range(2)})
        self.assertEqual(set(payload["questions"]), {f"{name}_{i}" for name in instructions for i in range(2)})
        self.assertEqual(len(expected_criteria["theme"]), 22)
        for i in range(2):
            for name in instructions:
                self.assertEqual(payload["questions"][f"{name}_{i}"], {
                    "type": "choice", "instructions": f"news_{i} {instructions[name]}",
                    "criteria": expected_criteria[name]})
        self.assertEqual(len({q["instructions"] for q in payload["questions"].values()}), 6)
        self.assertNotIn("private-key", json.dumps(payload))

    def test_twenty_item_limit_sixty_questions_and_local_indices(self):
        with server(lambda p, *_: (200, answers(len(p["state"])), {})) as (url, received):
            results = list(self.client(url).analyze_round(items(21)))
        self.assertEqual([len(r) for r in results], [20, 1])
        self.assertEqual([len(p[2]["questions"]) for p in received], [60, 3])
        self.assertEqual(set(received[1][2]["state"]), {"news_0"})
        self.assertEqual(set(results[1]), {"private-key-20"})

    def test_character_limit_includes_summary_and_counts_characters(self):
        with server(lambda p, *_: (200, answers(len(p["state"])), {})) as (url, received):
            results = list(self.client(url).analyze_round(items(3, "中" * 1500, "文" * 1500)))
        self.assertEqual([len(r) for r in results], [2, 1])
        self.assertEqual([sum(len(i["title"]) + len(i["summary"]) for i in p[2]["state"].values()) for p in received], [6000, 3000])

    def test_exact_character_limit(self):
        with server(lambda p, *_: (200, answers(len(p["state"])), {})) as (url, received):
            self.assertEqual([len(r) for r in self.client(url).analyze_round(items(3, "中" * 2000, "文" * 2000))], [2, 1])
            self.assertEqual(len(received), 2)

    def reject(self, body, status=200, headers=None):
        with server(lambda *_: (status, body, headers or {})) as (url, received):
            client = self.client(url)
            self.assertIsNone(client.analyze(items()))
            received.clear()
            self.assertEqual(list(client.analyze_round(items(21))), [])
            self.assertEqual(len(received), 1)

    def bad_each_question(self, mutate):
        for name in ("market", "theme", "dir"):
            with self.subTest(question=name):
                body = answers()
                mutate(body["answers"], f"{name}_1")  # First item's three answers stay valid.
                self.reject(body)

    def test_each_question_missing_rejects_whole_batch(self):
        self.bad_each_question(lambda a, k: a.pop(k))

    def test_each_question_not_object(self):
        self.bad_each_question(lambda a, k: a.update({k: []}))

    def test_each_question_missing_choice(self):
        self.bad_each_question(lambda a, k: a[k].pop("choice"))

    def test_each_question_choice_not_string(self):
        self.bad_each_question(lambda a, k: a[k].update(choice=[]))

    def test_each_question_choice_outside_its_own_options(self):
        self.bad_each_question(lambda a, k: a[k].update(choice="bull" if k != "dir_1" else "positive"))

    def test_each_question_missing_probabilities(self):
        self.bad_each_question(lambda a, k: a[k].pop("probabilities"))

    def test_each_question_probabilities_not_object(self):
        self.bad_each_question(lambda a, k: a[k].update(probabilities=[]))

    def test_each_question_empty_probabilities(self):
        self.bad_each_question(lambda a, k: a[k].update(probabilities={}))

    def test_each_question_non_numeric_or_invalid_probability(self):
        for value in ("0.8", None, True, -0.1, 1.1, float("nan"), float("inf")):
            with self.subTest(value=value):
                self.bad_each_question(lambda a, k: a[k].update(probabilities={"value": value}))

    def test_non_200(self):
        self.reject(answers(), status=201)

    def test_non_json(self):
        self.reject(b'invalid')

    def test_document_not_object(self):
        self.reject([])

    def test_missing_answers(self):
        self.reject({})

    def test_answers_not_object(self):
        self.reject({"answers": []})

    def test_body_over_one_mib(self):
        body = json.dumps(answers()).encode()
        self.reject(body + b' ' * (MAX_BODY + 1 - len(body)))

    def test_body_exact_one_mib(self):
        body = json.dumps(answers()).encode()
        with server(lambda *_: (200, body + b' ' * (MAX_BODY - len(body)), {})) as (url, _):
            self.assertEqual(len(self.client(url).analyze(items())), 2)

    def test_truncated_body(self):
        self.reject(answers(), headers={"Content-Length": "10000"})

    def threshold(self, name, fallback, original):
        for value, expected in ((0.34, fallback), (0.35, original)):
            with self.subTest(probability=value):
                body = answers(1)
                body["answers"][f"{name}_0"]["probabilities"] = {original: value}
                with server(lambda *_: (200, body, {})) as (url, _):
                    result = self.client(url).analyze(items(1))["private-key-0"]
                reference = {"kind": "finance", "market": "positive", "theme": "memory", "dir": "bull", "dir_p": 0.8}
                reference[name] = expected
                if name == "dir":
                    reference["dir_p"] = value
                self.assertEqual(result, reference)

    def test_market_threshold_both_sides(self):
        self.threshold("market", "other", "positive")

    def test_theme_threshold_both_sides(self):
        self.threshold("theme", "other", "memory")

    def test_direction_threshold_both_sides(self):
        self.threshold("dir", "neutral", "bull")

    def test_dir_p_rounding_preserves_raw_max_not_choice_probability(self):
        for value, expected in ((0.125, 0.13), (0.345, 0.35), (0.346, 0.35), (0.354, 0.35), (0.876, 0.88), (0.874, 0.87), (1, 1.0)):
            with self.subTest(value=value):
                body = answers(1)
                body["answers"]["dir_0"]["probabilities"] = {"bull": 0.1, "bear": value}
                with server(lambda *_: (200, body, {})) as (url, _):
                    result = self.client(url).analyze(items(1))["private-key-0"]
                self.assertEqual(result["dir_p"], expected)
                self.assertEqual(result["dir"], "neutral" if value < 0.35 else "bull")

    def test_401_and_403_permanently_disable(self):
        for status in (401, 403):
            with self.subTest(status=status), server(lambda *_: (status, b'analysis-secret', {})) as (url, received):
                client = self.client(url)
                self.assertEqual(list(client.analyze_round(items(21))), [])
                self.assertFalse(client.enabled)
                self.assertIsNone(client.analyze(items()))
                self.assertEqual(list(client.analyze_round(items(21))), [])
                self.assertEqual(len(received), 1)

    def transient(self, status):
        def respond(payload, n, release):
            if n == 1:
                if status == "timeout":
                    release.wait(1)
                    return 200, answers(), {}
                return status, {}, {}
            return 200, answers(len(payload["state"])), {}
        with server(respond) as (url, received):
            client = self.client(url, timeout=0.05)
            self.assertEqual(list(client.analyze_round(items(21))), [])
            self.assertTrue(client.enabled)
            self.assertEqual(len(received), 1)
            self.assertEqual([len(r) for r in client.analyze_round(items(21))], [20, 1])
            self.assertEqual(len(received), 3)

    def test_429_stops_round_then_next_round_retries(self):
        self.transient(429)

    def test_500_stops_round_then_next_round_retries(self):
        self.transient(500)

    def test_timeout_stops_round_then_next_round_retries(self):
        self.transient("timeout")

    def test_later_malformed_batch_keeps_only_prior_success(self):
        with server(lambda p, n, _: (200, answers(len(p["state"])) if n != 2 else {}, {})) as (url, received):
            client = self.client(url)
            self.assertEqual([len(r) for r in client.analyze_round(items(41))], [20])
            self.assertEqual(len(received), 2)
            self.assertEqual([len(r) for r in client.analyze_round(items(1))], [1])

    def test_sixty_second_budget_and_reset(self):
        now = [0]
        def respond(payload, *_):
            time.sleep(0.005)
            now[0] += 30
            return 200, answers(len(payload["state"])), {}
        with server(respond) as (url, received):
            client = self.client(url, clock=lambda: now[0])
            self.assertEqual([len(r) for r in client.analyze_round(items(61))], [20, 20])
            self.assertEqual(len(received), 2)
            self.assertEqual(now[0], 60)
            self.assertEqual([len(r) for r in client.analyze_round(items(1))], [1])

    def test_no_key_and_no_test_environment_endpoint(self):
        with patch.dict(os.environ, {"NEWS_TEST_JEV_URL": "http://invalid", "TYPESAFE_API_KEY": ""}, clear=True):
            client = Analyzer(log=lambda _: None)
        self.assertFalse(client.enabled)
        self.assertEqual(client.endpoint, "https://api.typesafe.ai/v1/systemone")
        self.assertIsNone(client.analyze(items()))
        self.assertEqual(list(client.analyze_round(items())), [])

    def test_no_redirects(self):
        with server(lambda *_: (302, b'', {"Location": "/target"})) as (url, received):
            self.assertIsNone(self.client(url).analyze(items()))
            self.assertEqual(len(received), 1)

    def test_default_timeout_and_secret_never_logged(self):
        logs = []
        client = Analyzer(key="analysis-secret", log=logs.append)
        self.assertEqual(client.timeout, 15)
        self.assertEqual(client.budget, 60)
        with patch.object(client._opener, "open", side_effect=OSError("analysis-secret")) as opened:
            self.assertIsNone(client.analyze(items()))
            self.assertEqual(opened.call_args.kwargs["timeout"], 15)
        self.assertTrue(logs)
        self.assertNotIn("analysis-secret", ''.join(logs))

    def test_tls_required_and_missing_ca_refuses_network(self):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        client = Analyzer(key="test", ssl_context=context, ca_file="/nonexistent-ca.pem", log=lambda _: None)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        with patch.object(client._opener, "open") as opened:
            self.assertIsNone(client.analyze(items()))
            opened.assert_not_called()

    def test_empty_input_and_oversize_never_sent(self):
        with server() as (url, received):
            client = self.client(url)
            self.assertEqual(client.analyze([]), {})
            self.assertEqual(list(client.analyze_round([])), [])
            self.assertIsNone(client.analyze(items(21)))
            self.assertIsNone(client.analyze(items(1, "x" * 8001, "")))
            self.assertEqual(list(client.analyze_round(items(1, "x" * 8001, ""))), [])
            self.assertEqual(received, [])


def world_answers(n=2, probability=0.8):
    return {'answers': {f'{name}_{i}': {'choice': choice, 'probabilities': {choice: probability}}
                        for i in range(n) for name, choice in
                        (('trend', 'escalation'), ('region', 'asia_pacific'))}}


class WorldAnalyzeTests(unittest.TestCase):
    def client(self, url):
        return Analyzer(endpoint=url, key='world-test-secret', log=lambda _: None)

    def test_exact_spec_questions_criteria_named_state_and_kind(self):
        spec = (Path(__file__).resolve().parents[1] / 'docs/SPEC.md').read_text()
        section = spec.split('### 17.1', 1)[1].split('### 17.2', 1)[0]
        expected = {}
        for name in ['trend', 'region']:
            part = section.split(f'- `{name}`：', 1)[1].split('\n- ', 1)[0]
            expected[name] = {}
            for line in part.splitlines():
                if line.strip().startswith('| `'):
                    cells = [c.strip() for c in line.strip().strip('|').split('|')]
                    expected[name][cells[0].strip('`')] = cells[-1]
        instructions = {'trend': '這則報導描述的國際衝突或緊張情勢，走向是什麼？',
                        'region': '這則報導主要涉及哪個地區？'}
        with server(lambda p, *_: (200, world_answers(len(p['state'])), {})) as (url, received):
            result = self.client(url).analyze(items(), kind='world')
        self.assertEqual(result, {f'private-key-{i}': {'kind': 'world', 'trend': 'escalation', 'region': 'asia_pacific'} for i in range(2)})
        payload = received[0][2]
        self.assertEqual(payload['model'], 'jev-1.13.0')
        self.assertEqual(payload['state'], {f'news_{i}': {'title': '標題', 'summary': '摘要'} for i in range(2)})
        self.assertEqual(set(payload['questions']), {'trend_0', 'region_0', 'trend_1', 'region_1'})
        self.assertEqual(len(expected['trend']), 5)
        self.assertEqual(len(expected['region']), 6)
        for i in range(2):
            for name, instruction in instructions.items():
                self.assertEqual(payload['questions'][f'{name}_{i}'], {
                    'type': 'choice', 'instructions': f'news_{i} {instruction}', 'criteria': expected[name]})
        self.assertEqual(len({q['instructions'] for q in payload['questions'].values()}), 4)
        self.assertNotIn('private-key', json.dumps(payload))

    def test_both_questions_threshold_034_035(self):
        for name in ['trend', 'region']:
            for probability in [.34, .35]:
                with self.subTest(name=name, probability=probability):
                    body = world_answers()
                    original = body['answers'][f'{name}_0']['choice']
                    body['answers'][f'{name}_0']['probabilities'] = {original: probability}
                    with server(lambda *_: (200, body, {})) as (url, _):
                        result = self.client(url).analyze(items(), kind='world')
                    self.assertEqual(result['private-key-0'][name], 'other' if probability < .35 else original)
                    self.assertEqual(result['private-key-0']['kind'], 'world')

    def test_world_twenty_items_forty_questions_and_character_batching(self):
        with server(lambda p, *_: (200, world_answers(len(p['state'])), {})) as (url, received):
            client = self.client(url)
            self.assertEqual([len(r) for r in client.analyze_round(items(21), kind='world')], [20, 1])
            self.assertEqual([len(p['questions']) for _, _, p in received], [40, 2])
            self.assertEqual(set(received[1][2]['state']), {'news_0'})
            received.clear()
            self.assertEqual([len(r) for r in client.analyze_round(items(3, '中'*2000, '文'*2000), kind='world')], [2, 1])
            self.assertEqual([sum(len(i['title'])+len(i['summary']) for i in p['state'].values()) for _, _, p in received], [8000, 4000])

    def test_finance_world_requests_stay_separate_and_default_resets(self):
        def response(payload, *_):
            return 200, world_answers(len(payload['state'])) if 'trend_0' in payload['questions'] else answers(len(payload['state'])), {}
        with server(response) as (url, received):
            client = self.client(url)
            world = client.analyze(items(1, 'world'), kind='world')
            finance = client.analyze(items(1, 'finance'))
        self.assertEqual(world['private-key-0']['kind'], 'world')
        self.assertEqual(finance['private-key-0']['kind'], 'finance')
        self.assertEqual([set(p['questions']) for _, _, p in received], [{'trend_0', 'region_0'}, {'market_0', 'theme_0', 'dir_0'}])
        self.assertEqual([p['state']['news_0']['title'] for _, _, p in received], ['world', 'finance'])

    def test_invalid_world_answer_rejects_entire_batch(self):
        for name in ['trend', 'region']:
            for invalid in [None, {}, {'choice': 'finance', 'probabilities': {'finance': 1}},
                            {'choice': 'other', 'probabilities': {}}, {'choice': 'other', 'probabilities': {'other': True}}]:
                with self.subTest(name=name, invalid=invalid):
                    body = world_answers()
                    body['answers'][f'{name}_1'] = invalid
                    with server(lambda *_: (200, body, {})) as (url, _):
                        self.assertIsNone(self.client(url).analyze(items(), kind='world'))

    def test_tagged_validation_and_legacy_finance(self):
        from back.analyze import valid_analysis
        world = {'kind': 'world', 'trend': 'not_conflict', 'region': 'other'}
        finance = {'market': 'positive', 'theme': 'memory', 'dir': 'bull', 'dir_p': .8}
        self.assertTrue(valid_analysis(world))
        self.assertTrue(valid_analysis(finance))
        self.assertTrue(valid_analysis(dict(finance, kind='finance')))
        for invalid in [dict(world, kind='finance'), dict(finance, kind='world'), dict(world, kind=[]),
                        dict(world, region='zzz'), dict(world, trend={}), dict(world, kind='zzz'), None]:
            self.assertFalse(valid_analysis(invalid))
