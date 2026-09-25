from contextlib import contextmanager, redirect_stderr
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
import ssl
import threading
import time
import unittest
from unittest.mock import patch

from back.classify import Classifier, CRITERIA, ENDPOINT, MAX_BODY
from back.fetch import USER_AGENT


def items(n=2, title="標題", summary="摘要"):
    return [(f"private-key-{i}", title, summary) for i in range(n)]


def answers(n=2, probability=0.8):
    return {"answers": {f"item_{i}": {"choice": "tech", "probabilities": {"tech": probability}}
                        for i in range(n)}}


@contextmanager
def server(respond=None, *, drip_interval=None):
    received = []
    release = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            received.append((self.path, dict(self.headers), payload))
            status, body, headers = (respond(payload, len(received), release) if respond else
                                     (200, answers(len(payload["state"])), {}))
            if not isinstance(body, bytes):
                body = json.dumps(body).encode()
            try:
                self.send_response(status)
                for name, value in headers.items():
                    self.send_header(name, value)
                if "Content-Length" not in headers:
                    self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if drip_interval is None:
                    self.wfile.write(body)
                else:
                    for byte in body:
                        self.wfile.write(bytes([byte]))
                        self.wfile.flush()
                        if release.wait(drip_interval):
                            break
            except (BrokenPipeError, ConnectionResetError):
                pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=lambda: httpd.serve_forever(poll_interval=0.01), daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_port}/jev", received
    finally:
        release.set()
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2)


class ClassifyTests(unittest.TestCase):
    def client(self, endpoint, **kwargs):
        return Classifier(endpoint=endpoint, key="unique-secret-test", log=lambda _: None, **kwargs)

    def reject(self, body, status=200, headers=None):
        # The first answer is valid wherever the enclosing structure permits;
        # a bad second answer must not leak even the first key as a candidate.
        with server(lambda *_: (status, body, headers or {})) as (url, received):
            client = self.client(url)
            self.assertIsNone(client.classify(items()))
            received.clear()
            self.assertEqual(list(client.classify_round(items(21))), [])
            self.assertEqual(len(received), 1)

    def bad_answer(self, change):
        body = answers()
        change(body["answers"]["item_1"])
        self.reject(body)

    def test_request_shape(self):
        with server() as (url, received):
            result = self.client(url).classify(items())
        self.assertEqual(result, {"private-key-0": "tech", "private-key-1": "tech"})
        path, raw_headers, payload = received[0]
        headers = {k.lower(): v for k, v in raw_headers.items()}
        self.assertEqual(path, "/jev")
        self.assertEqual(headers["authorization"], "Bearer unique-secret-test")
        self.assertEqual(headers["content-type"], "application/json")
        self.assertEqual(headers["user-agent"], USER_AGENT)
        self.assertEqual(set(payload), {"model", "state", "questions"})
        self.assertEqual(payload["model"], "jev-1.13.0")
        self.assertIsInstance(payload["state"], dict)
        self.assertEqual(set(payload["state"]), {"news_0", "news_1"})
        self.assertEqual(payload["state"], {f"news_{i}": {"title": "標題", "summary": "摘要"} for i in range(2)})
        self.assertEqual(set(payload["questions"]), {"item_0", "item_1"})
        self.assertEqual(set(CRITERIA), {"politics", "finance", "tech", "world", "society", "life", "sports", "entertainment", "other"})
        for i, question in enumerate(payload["questions"].values()):
            self.assertEqual(set(question), {"type", "instructions", "criteria"})
            self.assertEqual(question["type"], "choice")
            self.assertEqual(question["criteria"], CRITERIA)
            self.assertEqual(question["instructions"], f"news_{i} 這則新聞屬於哪一類？")
            self.assertIn(f"news_{i}", question["instructions"])
        instructions = [q["instructions"] for q in payload["questions"].values()]
        self.assertEqual(len(set(instructions)), len(instructions))
        self.assertEqual(payload["questions"]["item_0"]["criteria"], payload["questions"]["item_1"]["criteria"])
        self.assertEqual(CRITERIA["other"], "以上皆非")
        self.assertNotIn("private-key", json.dumps(payload))

    def test_twenty_item_limit(self):
        with server() as (url, received):
            results = list(self.client(url).classify_round(items(21)))
        self.assertEqual([len(r) for r in results], [20, 1])
        self.assertEqual([len(r[2]["state"]) for r in received], [20, 1])
        self.assertEqual(results[1], {"private-key-20": "tech"})
        self.assertEqual(set(received[1][2]["state"]), {"news_0"})
        for _, _, payload in received:
            size = len(payload["state"])
            self.assertEqual(set(payload["state"]), {f"news_{i}" for i in range(size)})
            instructions = [payload["questions"][f"item_{i}"]["instructions"] for i in range(size)]
            self.assertEqual(len(set(instructions)), size)
            for i, instruction in enumerate(instructions):
                self.assertEqual(instruction, f"news_{i} 這則新聞屬於哪一類？")

    def test_eight_thousand_character_limit(self):
        with server() as (url, received):
            results = list(self.client(url).classify_round(items(3, "中" * 1500, "文" * 1500)))
        self.assertEqual([len(r) for r in results], [2, 1])
        self.assertEqual([sum(len(i["title"]) + len(i["summary"]) for i in r[2]["state"].values())
                          for r in received], [6000, 3000])

    def test_exact_character_limit(self):
        with server() as (url, received):
            self.assertEqual([len(r) for r in self.client(url).classify_round(items(3, "中" * 2000, "文" * 2000))], [2, 1])
            self.assertEqual(len(received), 2)

    def test_non_200(self):
        self.reject(answers(), status=201)

    def test_non_json(self):
        self.reject(b'{"answers": invalid}')

    def test_json_not_object(self):
        self.reject([answers()])

    def test_missing_answers(self):
        self.reject({})

    def test_answers_not_object(self):
        self.reject({"answers": []})

    def test_missing_item(self):
        self.reject(answers(1))

    def test_answer_not_object(self):
        body = answers()
        body["answers"]["item_1"] = []
        self.reject(body)

    def test_missing_choice(self):
        self.bad_answer(lambda a: a.pop("choice"))

    def test_choice_not_string(self):
        self.bad_answer(lambda a: a.update(choice=["tech"]))

    def test_choice_not_in_categories(self):
        self.bad_answer(lambda a: a.update(choice="unknown"))

    def test_missing_probabilities(self):
        self.bad_answer(lambda a: a.pop("probabilities"))

    def test_probabilities_not_object(self):
        self.bad_answer(lambda a: a.update(probabilities=[0.8]))

    def test_empty_probabilities(self):
        self.bad_answer(lambda a: a.update(probabilities={}))

    def test_probability_not_number(self):
        self.bad_answer(lambda a: a.update(probabilities={"tech": 0.8, "other": "0.2"}))

    def test_probability_boolean(self):
        self.bad_answer(lambda a: a.update(probabilities={"tech": True}))

    def test_probability_negative(self):
        self.bad_answer(lambda a: a.update(probabilities={"tech": -0.1}))

    def test_probability_above_one(self):
        self.bad_answer(lambda a: a.update(probabilities={"tech": 1.1}))

    def test_probability_nan(self):
        self.bad_answer(lambda a: a.update(probabilities={"tech": float("nan")}))

    def test_probability_infinite(self):
        self.bad_answer(lambda a: a.update(probabilities={"tech": float("inf")}))

    def test_body_over_one_mib(self):
        body = json.dumps(answers()).encode()
        self.reject(body + b" " * (MAX_BODY + 1 - len(body)))

    def test_body_exact_one_mib(self):
        body = json.dumps(answers()).encode()
        with server(lambda *_: (200, body + b" " * (MAX_BODY - len(body)), {})) as (url, _):
            self.assertEqual(len(self.client(url).classify(items())), 2)

    def test_truncated_body(self):
        self.reject(answers(), headers={"Content-Length": "10000"})

    def test_threshold_034(self):
        with server(lambda *_: (200, answers(probability=0.34), {})) as (url, _):
            self.assertEqual(set(self.client(url).classify(items()).values()), {"other"})

    def test_threshold_035(self):
        with server(lambda *_: (200, answers(probability=0.35), {})) as (url, _):
            self.assertEqual(set(self.client(url).classify(items()).values()), {"tech"})

    def test_threshold_uses_maximum_not_choice_probability(self):
        body = answers()
        body["answers"]["item_1"]["probabilities"] = {"tech": 0.1, "other": 0.9}
        with server(lambda *_: (200, body, {})) as (url, _):
            self.assertEqual(set(self.client(url).classify(items()).values()), {"tech"})

    def permanent(self, status):
        with server(lambda *_: (status, b"unique-secret-test", {})) as (url, received):
            client = self.client(url)
            self.assertEqual(list(client.classify_round(items(21))), [])
            self.assertFalse(client.enabled)
            self.assertIsNone(client.classify(items()))
            self.assertEqual(list(client.classify_round(items(21))), [])
            self.assertEqual(len(received), 1)

    def test_401_permanently_disables(self):
        self.permanent(401)

    def test_403_permanently_disables(self):
        self.permanent(403)

    def transient(self, status):
        def respond(payload, count, release):
            if count == 1:
                if status == "timeout":
                    release.wait(1)
                    return 200, answers(), {}
                return status, answers(), {}
            return 200, answers(len(payload["state"])), {}
        with server(respond) as (url, received):
            client = self.client(url, timeout=0.05)
            self.assertEqual(list(client.classify_round(items(21))), [])
            self.assertTrue(client.enabled)
            self.assertEqual(len(received), 1)
            self.assertEqual([len(r) for r in client.classify_round(items(21))], [20, 1])
            self.assertEqual(len(received), 3)

    def test_429_stops_round_then_retries_next_round(self):
        self.transient(429)

    def test_500_stops_round_then_retries_next_round(self):
        self.transient(500)

    def test_timeout_stops_round_then_retries_next_round(self):
        self.transient("timeout")

    def test_malformed_stops_round_then_retries_next_round(self):
        with server(lambda p, n, _: (200, b"invalid" if n == 1 else answers(len(p["state"])), {})) as (url, received):
            client = self.client(url)
            self.assertEqual(list(client.classify_round(items(21))), [])
            self.assertEqual(len(received), 1)
            self.assertEqual([len(r) for r in client.classify_round(items(21))], [20, 1])

    def test_prior_success_survives_later_failed_batch(self):
        with server(lambda p, n, _: (200, answers(len(p["state"])) if n == 1 else b"invalid", {})) as (url, received):
            self.assertEqual([len(r) for r in self.client(url).classify_round(items(41))], [20])
            self.assertEqual(len(received), 2)

    def test_sixty_second_budget_with_injected_clock(self):
        now = [100.0]
        def respond(payload, count, release):
            time.sleep(0.01)
            now[0] += 30
            return 200, answers(len(payload["state"])), {}
        with server(respond) as (url, received):
            client = self.client(url, clock=lambda: now[0], read_deadline=120)
            self.assertEqual([len(r) for r in client.classify_round(items(61))], [20, 20])
            self.assertEqual(now[0], 160)
            self.assertEqual(len(received), 2)
            self.assertEqual([len(r) for r in client.classify_round(items(1))], [1])
            self.assertEqual(len(received), 3)

    def test_inflight_completion_after_budget_is_accepted(self):
        now = [0]
        def respond(payload, *_):
            now[0] += 61
            return 200, answers(len(payload["state"])), {}
        with server(respond) as (url, received):
            self.assertEqual([len(r) for r in self.client(url, clock=lambda: now[0], read_deadline=120).classify_round(items(21))], [20])
            self.assertEqual(len(received), 1)

    def test_no_redirect_is_followed(self):
        for status in (301, 302, 303, 307, 308):
            with self.subTest(status=status), server(lambda *_: (status, b"", {"Location": "/target"})) as (url, received):
                self.assertIsNone(self.client(url).classify(items()))
                self.assertEqual(len(received), 1)

    def test_environment_key_read_once_and_test_endpoint_ignored(self):
        with patch.dict(os.environ, {"TYPESAFE_API_KEY": "test", "NEWS_TEST_JEV_URL": "http://invalid/", "NEWS_TEST_DIR": "/tmp"}):
            client = Classifier(log=lambda _: None)
            self.assertEqual(client.endpoint, ENDPOINT)
            self.assertEqual(client.timeout, 15)
            self.assertEqual(client.budget, 60)
            with server() as (url, received):
                client.endpoint = url
                with patch.dict(os.environ, {"TYPESAFE_API_KEY": "changed"}):
                    self.assertIsNotNone(client.classify(items()))
                self.assertEqual(received[0][1]["Authorization"], "Bearer test")

    def test_no_key_stays_disabled_and_logs_once_without_threads(self):
        output = io.StringIO()
        with server() as (url, received), patch.dict(os.environ, {}, clear=True), redirect_stderr(output):
            before = set(threading.enumerate())
            client = Classifier(endpoint=url)
            with patch.dict(os.environ, {"TYPESAFE_API_KEY": "later"}):
                self.assertIsNone(client.classify(items()))
                self.assertEqual(list(client.classify_round(items(21))), [])
            self.assertFalse(client.enabled)
            self.assertEqual(received, [])
            self.assertEqual(set(threading.enumerate()), before)
        self.assertEqual(output.getvalue(), "classify: disabled (no TYPESAFE_API_KEY)\n")

    def test_logs_do_not_contain_secret_or_exception_text(self):
        output = io.StringIO()
        with server(lambda *_: (401, b"unique-secret-test", {})) as (url, _), redirect_stderr(output):
            client = Classifier(endpoint=url, key="unique-secret-test")
            client.classify(items())
            client.enabled = True
            with patch.object(client._opener, "open", side_effect=OSError("unique-secret-test")):
                self.assertIsNone(client.classify(items()))
        self.assertNotIn("unique-secret-test", output.getvalue())
        self.assertIn("HTTP 401", output.getvalue())

    def test_tls_enforces_verification_and_ca_fallback(self):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        client = Classifier(key="test", ssl_context=context)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        self.assertTrue(client.has_ca)
        self.assertIs(client.ssl_context, context)

    def test_no_ca_refuses_https_before_network(self):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        client = Classifier(key="test", ssl_context=context, ca_file="/nonexistent-ca.pem", log=lambda _: None)
        self.assertFalse(client.has_ca)
        with patch.object(client._opener, "open") as opened:
            self.assertIsNone(client.classify(items()))
            opened.assert_not_called()
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)

    def test_socket_timeout_is_passed_to_opener(self):
        client = Classifier(key="test", log=lambda _: None)
        with patch.object(client._opener, "open", side_effect=TimeoutError) as opened:
            self.assertIsNone(client.classify(items()))
            self.assertEqual(opened.call_args.kwargs["timeout"], 15)

    def test_oversized_single_batch_never_sent(self):
        with server() as (url, received):
            client = self.client(url)
            self.assertIsNone(client.classify(items(21)))
            self.assertIsNone(client.classify(items(1, "x" * 8001, "")))
            self.assertEqual(list(client.classify_round(items(1, "x" * 8001, ""))), [])
            self.assertEqual(received, [])


if __name__ == "__main__":
    unittest.main()


class ResponseDeadlineTests(unittest.TestCase):
    def test_drip_body_stops_within_deadline_plus_one_interval(self):
        logs = []
        with server(drip_interval=0.2) as (url, received):
            client = Classifier(endpoint=url, key='deadline-secret', read_deadline=1, log=logs.append)
            started = time.monotonic()
            self.assertIsNone(client.classify(items()))
            elapsed = time.monotonic() - started
            self.assertGreaterEqual(elapsed, 1)
            self.assertLessEqual(elapsed, 1.2)
            self.assertEqual(len(received), 1)
            self.assertTrue(client.enabled)
        self.assertEqual(logs, ['classify: response deadline'])

    def test_deadline_starts_before_request_using_injected_clock(self):
        now, logs = [0], []
        def respond(*_):
            now[0] = 2
            return 200, answers(), {}
        with server(respond) as (url, _):
            client = Classifier(endpoint=url, key='test', clock=lambda: now[0], read_deadline=1, log=logs.append)
            self.assertIsNone(client.classify(items()))
        self.assertEqual(logs, ['classify: response deadline'])

    def test_normal_response_and_shared_deadline_settings(self):
        from back.analyze import Analyzer
        from back.events import EventMatcher
        with server() as (url, _):
            client = Classifier(endpoint=url, key='test', read_deadline=7, log=lambda _: None)
            self.assertEqual(client.classify(items()), {key: 'tech' for key, _, _ in items()})
            self.assertEqual(Analyzer(shared=client).read_deadline, 7)
            self.assertEqual(EventMatcher(shared=client).read_deadline, 7)
        self.assertEqual(Classifier(key='test').read_deadline, 30)
        for value in [0, -1]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                Classifier(key='test', read_deadline=value)
