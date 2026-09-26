import array
import fcntl
import json
import os
from pathlib import Path
import secrets
import select
import subprocess
import sys
import tempfile
import termios
import time
import unittest

from back.news import preflight

ROOT = Path(__file__).resolve().parents[1]


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.directory = Path(self.tmp.name)
        self.process = None
        self.buffer = b""
        self.stdout_seen = bytearray()
        self.seq = secrets.randbelow(2**40) + 2

    def tearDown(self):
        if self.process:
            if self.process.poll() is None:
                self.process.kill()
            self.process.wait(timeout=2)
            for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
                stream.close()
        self.tmp.cleanup()

    def start(self, mode="", feeds=None, version=None, extra_args=(), scheduler_options=None, wrapper=None, extra_env=None):
        env = {k: v for k, v in os.environ.items() if not k.startswith("NEWS_TEST_") and k != "TYPESAFE_API_KEY"}
        env.update(NEWS_TEST_DIR=str(self.directory), NEWS_TEST_MODE=mode)
        if feeds:
            env["NEWS_TEST_FEEDS"] = str(feeds)
        if scheduler_options:
            env["NEWS_TEST_SCHEDULER"] = json.dumps(scheduler_options)
        env.update(extra_env or {})
        command = [sys.executable, str(ROOT / "back/news.py")]
        if wrapper:
            command = [sys.executable, "-c", wrapper]
        if version:
            # Patch only the version input; execute the actual subprocess main.
            command = [sys.executable, "-c", "from back import news; import sys; "
                       "original = news.preflight; "
                       f"news.preflight = lambda p: original(p, {version}); "
                       "sys.exit(news.main())"]
        command.extend(extra_args)
        self.process = subprocess.Popen(command, cwd=ROOT, env=env, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        self.marker("preflight-complete")

    def marker(self, name):
        deadline = time.monotonic() + 3
        while not (self.directory / name).exists():
            self.assertIsNone(self.process.poll(), f"exited before {name}")
            if time.monotonic() >= deadline:
                self.fail(f"missing marker: {name}")
            time.sleep(0.002)

    def send(self, kind, seq=None):
        self.process.stdin.write((json.dumps({"t": kind, "seq": self.seq if seq is None else seq}) + "\n").encode())

    def packet(self):
        deadline = time.monotonic() + 3
        while b"\n" not in self.buffer:
            remaining = deadline - time.monotonic()
            self.assertGreater(remaining, 0, "packet timeout")
            self.assertTrue(select.select([self.process.stdout], [], [], remaining)[0])
            chunk = os.read(self.process.stdout.fileno(), 65536)
            self.assertTrue(chunk, "EOF before packet")
            self.stdout_seen.extend(chunk)
            self.buffer += chunk
        line, self.buffer = self.buffer.split(b"\n", 1)
        return json.loads(line)

    def hello(self):
        self.send("hello")
        self.assertEqual(self.packet(), {"t": "ready", "seq": self.seq})

    def exited(self, started, code=0):
        self.assertEqual(self.process.wait(timeout=max(0.001, 1 - (time.monotonic() - started))), code)
        self.assertLess(time.monotonic() - started, 1)

    def tail(self):
        rest = self.process.stdout.read()
        self.stdout_seen.extend(rest)
        data = self.buffer + rest
        self.buffer = b""
        return [json.loads(line) for line in data.splitlines()]

    def test_hello_ready_and_bye_done_last(self):
        self.start()
        self.hello()
        started = time.monotonic()
        self.send("bye")
        self.exited(started)
        self.assertEqual(self.tail(), [{"t": "done", "seq": self.seq}])

    def test_bad_feeds_fail_only_after_hello(self):
        feeds = self.directory / "bad.json"
        feeds.write_text("[broken", encoding="utf-8")
        self.start(feeds=feeds)
        self.assertFalse(select.select([self.process.stdout], [], [], 0.05)[0])
        self.send("hello")
        packet = self.packet()
        self.assertEqual((packet["t"], packet["seq"]), ("fail", self.seq))
        self.assertIn("feeds.json", packet["reason"])
        self.process.wait(timeout=1)
        self.assertEqual(self.process.returncode, 1)
        self.assertEqual(self.tail(), [])

    def test_old_python_fail_after_hello(self):
        self.check_version("python_version=(3, 11)", "Python")

    def test_old_expat_fail_after_hello(self):
        self.check_version("expat_version=(2, 5)", "Expat")

    def check_version(self, version, reason):
        self.start(version=version)
        self.assertFalse(select.select([self.process.stdout], [], [], 0.05)[0])
        self.send("hello")
        packet = self.packet()
        self.assertEqual((packet["t"], packet["seq"]), ("fail", self.seq))
        self.assertIn(reason, packet["reason"])
        self.assertEqual(self.process.wait(timeout=1), 1)
        self.assertEqual(self.tail(), [])

    def test_wrong_seq_bye_is_discarded(self):
        self.start()
        self.hello()
        self.send("bye", self.seq + 1)
        self.marker("seq-discarded")
        self.assertIsNone(self.process.poll())
        started = time.monotonic()
        self.send("bye")
        self.exited(started)
        self.assertEqual(self.tail(), [{"t": "done", "seq": self.seq}])
        self.assertIn(b"seq mismatch", self.process.stderr.read())

    def test_invalid_seq_types_cannot_establish_session(self):
        self.start()
        for seq in (True, -1, 2**53, "2", 1.5):
            self.send("hello", seq)
        self.hello()
        started = time.monotonic()
        self.send("bye")
        self.exited(started)
        self.assertEqual(self.tail(), [{"t": "done", "seq": self.seq}])

    def test_eof_after_hello(self):
        self.start()
        self.hello()
        started = time.monotonic()
        self.process.stdin.close()
        self.exited(started)
        self.assertEqual(self.tail(), [{"t": "done", "seq": self.seq}])

    def test_eof_before_hello(self):
        self.start()
        started = time.monotonic()
        self.process.stdin.close()
        self.exited(started)
        self.assertEqual(self.tail(), [])

    def test_full_stdout_pipe_bye_exits_within_one_second(self):
        self.start(mode="flood")
        self.hello()
        self.send("up")
        self.marker("writer-entered")
        self.marker("up-handled")
        # No reader drains stdout. Confirm bytes in the pipe and that the
        # first 800 KiB business write has not completed, before sending bye.
        available = array.array("i", [0])
        deadline = time.monotonic() + 2
        while available[0] == 0 and time.monotonic() < deadline:
            fcntl.ioctl(self.process.stdout.fileno(), termios.FIONREAD, available)
            time.sleep(0.002)
        self.assertGreater(available[0], 0)
        self.assertFalse((self.directory / "writer-flushed").exists())
        self.assertIsNone(self.process.poll())
        started = time.monotonic()
        self.send("bye")
        self.exited(started)
        self.assertTrue((self.directory / "outbox-closed").exists())

    def test_paused_writer_done_is_last_and_late_put_rejected(self):
        self.start(mode="gate")
        self.hello()
        self.send("up")
        self.marker("writer-entered")
        self.marker("up-handled")
        self.assertFalse((self.directory / "writer-flushed").exists())
        started = time.monotonic()
        self.send("bye")
        self.marker("outbox-closed")
        self.marker("late-rejected")
        (self.directory / "writer-release").touch()
        self.exited(started)
        packets = self.tail()
        self.assertEqual(len(packets), 2)
        self.assertEqual(packets[0]["t"], "msg")
        self.assertEqual(packets[0]["body"]["index"], 0)
        self.assertEqual(packets[1], {"t": "done", "seq": self.seq})
        self.assertFalse((self.directory / "late-accepted").exists())


    def test_blocked_classifier_bye_exits_within_second_without_leaking_key(self):
        import threading
        from tests.test_classify import server, answers
        from tests.test_scheduler import feed_server
        entered = threading.Event()
        def respond(payload, count, release):
            entered.set()
            release.wait()  # No headers or body before subprocess exits.
            return 200, answers(len(payload["state"])), {}
        secret = "protocol-secret-" + secrets.token_hex(24)
        with feed_server() as (feed_url, _, _), server(respond) as (url, received):
            feeds = self.directory / "feeds.json"
            feeds.write_text(json.dumps([{"name": "Local", "url": feed_url}]))
            self.start(feeds=feeds, extra_args=["--allow-host", "127.0.0.1"],
                       extra_env={"TYPESAFE_API_KEY": secret, "NEWS_TEST_JEV_URL": url})
            self.assertFalse(entered.is_set())
            self.hello()
            self.assertFalse(entered.is_set())
            self.send("up")
            listing, publish = self.packet(), self.packet()
            self.assertEqual(listing["body"]["classify"], {"enabled": True, "pending": 1})
            self.assertEqual(publish["t"], "publish")
            self.assertTrue(entered.wait(2))
            self.assertEqual(len(received), 1)
            self.assertEqual(received[0][1]["Authorization"], "Bearer " + secret)
            self.assertFalse(select.select([self.process.stdout], [], [], 0.05)[0])
            self.assertIsNone(self.process.poll())
            started = time.monotonic()
            self.send("bye")
            self.exited(started)
            self.assertEqual(self.tail(), [{"t": "done", "seq": self.seq}])
            self.assertNotIn(secret.encode(), self.stdout_seen)
            self.assertNotIn(secret.encode(), self.process.stderr.read())

    def test_classifier_401_echoed_key_never_appears_in_protocol_or_logs(self):
        from tests.test_classify import server
        from tests.test_scheduler import feed_server
        secret = "protocol-secret-" + secrets.token_hex(24)
        with feed_server() as (feed_url, _, _), server(lambda *_: (401, secret.encode(), {})) as (url, received):
            feeds = self.directory / "feeds.json"
            feeds.write_text(json.dumps([{"name": "Local", "url": feed_url}]))
            self.start(feeds=feeds, extra_args=["--allow-host", "127.0.0.1"],
                       extra_env={"TYPESAFE_API_KEY": secret, "NEWS_TEST_JEV_URL": url})
            self.hello()
            self.send("up")
            listing, publish, update = self.packet(), self.packet(), self.packet()
            self.assertEqual(listing["body"]["classify"]["enabled"], True)
            self.assertEqual(publish["t"], "publish")
            self.assertEqual(update["body"]["classify"], {"enabled": False, "pending": 0})
            started = time.monotonic()
            self.send("bye")
            self.exited(started)
            self.assertEqual(self.tail(), [{"t": "done", "seq": self.seq}])
            logs = self.process.stderr.read()
            self.assertIn(b"classify: disabled (HTTP 401)", logs)
            self.assertNotIn(secret.encode(), self.stdout_seen)
            self.assertNotIn(secret.encode(), logs)
            self.assertEqual(len(received), 1)


    def test_blocked_analysis_bye_exits_within_second_and_key_never_logged(self):
        import threading
        from tests.test_classify import server
        from tests.test_scheduler import feed_server, model_kind
        from tests.test_analyze import answers
        entered = threading.Event()
        def respond(payload, n, release):
            if model_kind(payload) == 'analysis':
                entered.set()
                release.wait()  # Does not return until the process has exited.
                return 200, answers(len(payload['state'])), {}
            return 200, {'answers': {'item_0': {'choice': 'finance', 'probabilities': {'finance': 0.9}}}}, {}
        secret = 'analysis-protocol-secret-' + secrets.token_hex(24)
        with feed_server() as (feed_url, _, _), server(respond) as (url, received):
            feeds = self.directory / 'feeds.json'
            feeds.write_text(json.dumps([{'name': 'Local', 'url': feed_url}]))
            self.start(feeds=feeds, extra_args=['--allow-host', '127.0.0.1'],
                       extra_env={'TYPESAFE_API_KEY': secret, 'NEWS_TEST_JEV_URL': url})
            self.hello()
            self.assertEqual(received, [])
            self.send('up')
            initial, publish, classified = self.packet(), self.packet(), self.packet()
            self.assertEqual(initial['body']['items'][0]['analysis'], None)
            self.assertEqual(publish['t'], 'publish')
            self.assertEqual(classified['body']['analysis']['pending'], 1)
            self.assertTrue(entered.wait(2))
            self.assertEqual([model_kind(p) for _, _, p in received], ['classification', 'analysis'])
            self.assertTrue(all(headers['Authorization'] == 'Bearer ' + secret for _, headers, _ in received))
            self.assertFalse(select.select([self.process.stdout], [], [], 0.05)[0])
            self.assertIsNone(self.process.poll())
            started = time.monotonic()
            self.send('bye')
            self.exited(started)
            self.assertEqual(self.tail(), [{'t': 'done', 'seq': self.seq}])
            self.assertNotIn(secret.encode(), self.stdout_seen)
            self.assertNotIn(secret.encode(), self.process.stderr.read())

    def test_blocked_event_request_bye_exits_within_second_and_key_never_logged(self):
        import threading
        from tests.test_classify import server
        from tests.test_event_scheduler import response, kind
        entered = threading.Event()
        def respond(payload, n, release):
            if kind(payload) == 'events':
                entered.set()
                release.wait()
            return response(payload)
        secret = 'events-protocol-secret-' + secrets.token_hex(24)
        data = (b'<rss><channel><item><title>abcdef</title><link>https://example.com/a</link></item>'
                b'<item><title>abghij</title><link>https://example.com/b</link></item></channel></rss>')
        wrapper = ("from back import news; from back.fetch import Result; import sys; "
                   f"news.Fetcher.fetch = lambda *args: Result('ok', {data!r}, 'https://example.com/feed'); "
                   "sys.exit(news.main())")
        with server(respond) as (url, received):
            self.start(wrapper=wrapper, extra_env={'TYPESAFE_API_KEY': secret, 'NEWS_TEST_JEV_URL': url})
            self.hello()
            self.send('up')
            initial, publish = self.packet(), self.packet()
            self.assertEqual(initial['body']['events']['pending'], 1)
            self.assertTrue(all(len(i['event']) == 12 and i['event_size'] == 1 for i in initial['body']['items']))
            self.assertEqual(publish['t'], 'publish')
            self.assertTrue(entered.wait(2))
            # Other workers finish classification/analysis while the event HTTP
            # request remains blocked. Drain their updates before checking bye.
            while True:
                update = self.packet()['body']
                if update['classify']['pending'] == 0 and update['analysis']['pending'] == 0:
                    break
            self.assertCountEqual([kind(p) for _, _, p in received], ['classify', 'events', 'analysis'])
            started = time.monotonic()
            self.send('bye')
            self.exited(started)
            self.assertEqual(self.tail(), [{'t': 'done', 'seq': self.seq}])
            self.assertNotIn(secret.encode(), self.stdout_seen)
            self.assertNotIn(secret.encode(), self.process.stderr.read())

    def test_no_key_logs_disabled_once_for_both_clients(self):
        from tests.test_scheduler import feed_server
        with feed_server() as (url, _, _):
            feeds = self.directory / 'feeds.json'
            feeds.write_text(json.dumps([{'name': 'Local', 'url': url}]))
            self.start(feeds=feeds, extra_args=['--allow-host', '127.0.0.1'])
            self.hello()
            self.send('up')
            body = self.packet()['body']
            self.assertEqual(body['classify'], {'enabled': False, 'pending': 0})
            self.assertEqual(body['model'], {'state': 'off', 'reason': 'no_key'})
            self.assertEqual(body['analysis'], {'pending': 0})
            self.assertIsNone(body['items'][0]['analysis'])
            self.assertEqual(self.packet()['t'], 'publish')
            started = time.monotonic()
            self.send('bye')
            self.exited(started)
            self.assertEqual(self.tail(), [{'t': 'done', 'seq': self.seq}])
            logs = self.process.stderr.read()
            self.assertEqual(logs.count(b'disabled (no TYPESAFE_API_KEY)'), 1)


class PreflightTests(unittest.TestCase):
    def test_shipped_sixteen_sources(self):
        feeds, error = preflight(ROOT / "back/feeds.json")
        self.assertIsNone(error)
        self.assertEqual(len(feeds), 16)

    def test_invalid_shapes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "feeds.json"
            for value in ({}, [], [None], [{"name": "a", "url": "file:///tmp/x"}],
                          [{"name": "a", "url": "https://user:pass@example.com"}],
                          [{"name": "a", "url": "https://example.com"}] * 33):
                with self.subTest(value=value):
                    path.write_text(json.dumps(value), encoding="utf-8")
                    self.assertIsNotNone(preflight(path)[1])


class ClassifierWiringTests(unittest.TestCase):
    def test_test_endpoint_is_read_only_when_hooks_directory_is_set(self):
        import io
        from types import SimpleNamespace
        from unittest.mock import patch, Mock
        from back import news
        with tempfile.TemporaryDirectory() as directory:
            for hooks in (False, True):
                with self.subTest(hooks=hooks):
                    env = {"NEWS_TEST_JEV_URL": "http://127.0.0.1:9/jev", "TYPESAFE_API_KEY": "test"}
                    if hooks:
                        env["NEWS_TEST_DIR"] = directory
                    incoming = b'{"t":"hello","seq":42}\n{"t":"up","seq":42}\n{"t":"bye","seq":42}\n'
                    factory = Mock()
                    with patch.dict(os.environ, env, clear=True), patch.object(news, "Classifier") as constructor, \
                         patch.object(news.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(incoming))), \
                         patch.object(news.sys, "stdout", SimpleNamespace(buffer=io.BytesIO())):
                        self.assertEqual(news.main([], scheduler_factory=factory), 0)
                        if hooks:
                            constructor.assert_called_once_with(endpoint=env["NEWS_TEST_JEV_URL"])
                        else:
                            constructor.assert_called_once_with()
                        self.assertIs(factory.call_args.kwargs["classifier"], constructor.return_value)
                        factory.return_value.start.assert_called_once_with()
                        factory.return_value.stop.assert_called_once_with()
