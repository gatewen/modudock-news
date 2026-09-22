from contextlib import contextmanager
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import queue
import threading
import time
import unittest

from back.fetch import Result
from back.scheduler import Scheduler, Cache
from tests import test_protocol


def ok(label="new"):
    data = f'<rss><channel><item><title>{label}</title><link>https://example.com/{label}</link></item></channel></rss>'.encode()
    return Result("ok", data, "https://example.com/feed", {"etag": label})


def eventually(predicate, timeout=2):
    end = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() >= end:
            raise AssertionError("condition did not become true")
        time.sleep(0.002)


class Sink:
    def __init__(self):
        self.packets = queue.Queue()

    def put(self, packet):
        self.packets.put(deepcopy(packet))
        return True


class FunctionFetcher:
    def __init__(self, function):
        self.function = function

    def fetch(self, url, validators):
        return self.function(url, validators)


class SchedulerTests(unittest.TestCase):
    def setUp(self):
        self.schedulers = []
        self.gates = []

    def tearDown(self):
        for scheduler in self.schedulers:
            scheduler.stop()
        for gate in self.gates:
            gate.set()
        for scheduler in self.schedulers:
            for thread in scheduler.workers + [scheduler.coordinator] + ([scheduler.classify_worker] if scheduler.classify_worker else []):
                thread.join(timeout=2)
                self.assertFalse(thread.is_alive())

    def gate(self):
        gate = threading.Event()
        self.gates.append(gate)
        return gate

    def create(self, function, count=1, **options):
        sink, logs = Sink(), []
        defaults = dict(interval=10, source_timeout=0.3, round_timeout=0.6)
        defaults.update(options)
        scheduler = Scheduler([{"name": str(i), "url": str(i)} for i in range(count)],
                              FunctionFetcher(function), sink, 891, log=logs.append, **defaults)
        self.schedulers.append(scheduler)
        return scheduler, sink, logs

    def round(self, sink):
        listing, publish = sink.packets.get(timeout=2), sink.packets.get(timeout=2)
        self.assertEqual(listing["t"], "msg")
        self.assertEqual(publish["topic"], "news.fetched")
        self.assertEqual(publish["body"]["count"], len(listing["body"]["items"]))
        return listing["body"]

    def test_refresh_twice_coalesces_and_interval_from_completion(self):
        gate, entered = self.gate(), threading.Event()
        calls = []
        def fetch(*_):
            calls.append(time.monotonic())
            if len(calls) == 1:
                entered.set()
                gate.wait()
            return ok()
        scheduler, sink, _ = self.create(fetch, interval=0.12, source_timeout=1, round_timeout=2)
        scheduler.start()
        self.assertTrue(entered.wait(1))
        scheduler.refresh()
        scheduler.refresh()
        gate.set()
        self.round(sink)
        self.round(sink)
        eventually(lambda: scheduler.completed == 2)
        completed_at = time.monotonic()
        self.assertEqual(len(calls), 2)
        self.round(sink)
        self.assertEqual(len(calls), 3)
        self.assertGreaterEqual(calls[2] - completed_at, 0.10)

    def test_four_blocked_workers_three_rounds_bounded_then_recover(self):
        gate = self.gate()
        entered = set()
        lock = threading.Lock()
        def fetch(url, _):
            with lock:
                entered.add(url)
            gate.wait()
            return ok(url)
        scheduler, sink, _ = self.create(fetch, count=4, source_timeout=0.1, round_timeout=0.15)
        scheduler.start()
        eventually(lambda: len(entered) == 4)
        threads = tuple(scheduler.workers)
        active = threading.active_count()
        for n in range(3):
            start = time.monotonic()
            if n:
                scheduler.refresh()
            body = self.round(sink)
            self.assertLess(time.monotonic() - start, 0.4)
            self.assertTrue(all(s["error"] == "deadline" for s in body["sources"]))
            self.assertEqual(threading.active_count(), active)
            self.assertEqual(tuple(scheduler.workers), threads)
            self.assertEqual(len(threads), 4)
            self.assertTrue(all(t.daemon for t in threads))
            self.assertLessEqual(scheduler.jobs.qsize(), 32)
            self.assertEqual(scheduler.jobs.maxsize, 32)
        gate.set()
        scheduler.refresh()
        body = self.round(sink)
        self.assertTrue(all(s["ok"] for s in body["sources"]))
        self.assertEqual(len(body["items"]), 4)

    def test_late_old_candidate_cannot_overwrite_new_cache(self):
        old_gate, second_b = self.gate(), self.gate()
        old_entered, b_entered = threading.Event(), threading.Event()
        counts = {"0": 0, "1": 0}
        lock = threading.Lock()
        def fetch(url, _):
            with lock:
                counts[url] += 1
                n = counts[url]
            if url == "0" and n == 1:
                old_entered.set()
                old_gate.wait()
                return ok("old")
            if url == "1" and n == 2:
                b_entered.set()
                second_b.wait()
            return ok("new" + url)
        scheduler, sink, _ = self.create(fetch, count=2, source_timeout=0.4, round_timeout=1)
        scheduler.start()
        self.assertTrue(old_entered.wait(1))
        first = self.round(sink)
        self.assertEqual(first["sources"][0]["error"], "deadline")
        scheduler.refresh()
        self.assertTrue(b_entered.wait(1))
        eventually(lambda: scheduler.snapshot()[0].validators == {"etag": "new0"})
        before = scheduler.snapshot()[0]
        self.assertTrue(before.first_seen)
        with scheduler.cv:
            self.assertTrue(scheduler.active)
            self.assertEqual(scheduler.round_id, 2)
            processed = scheduler.processed_results
        old_gate.set()
        eventually(lambda: scheduler.processed_results > processed)
        self.assertEqual(scheduler.snapshot()[0], before)
        self.assertGreaterEqual(scheduler.dropped_results, 1)
        second_b.set()
        body = self.round(sink)
        self.assertEqual({i["title"] for i in body["items"]}, {"new0", "new1"})

    def test_new_round_replaces_queued_old_jobs_at_capacity(self):
        gate = self.gate()
        entered = set()
        lock = threading.Lock()
        def fetch(url, _):
            with lock:
                entered.add(url)
            gate.wait()
            return ok(url)
        scheduler, sink, _ = self.create(fetch, count=32, source_timeout=0.05, round_timeout=0.12)
        scheduler.start()
        eventually(lambda: len(entered) == 4)
        self.round(sink)
        with scheduler.cv:
            self.assertEqual(scheduler.jobs.qsize(), 28)
        scheduler.refresh()
        eventually(lambda: scheduler.round_id == 2)
        with scheduler.cv:
            self.assertEqual(scheduler.jobs.qsize(), 32)
            with scheduler.jobs.mutex:
                self.assertEqual({job[0] for job in scheduler.jobs.queue}, {2})
        self.assertEqual(len(entered), 4)  # No free worker could hide stale work.

    def test_cache_success_304_parse_failure_and_http_failure(self):
        replies = iter([ok(), Result("not_modified"),
                        Result("ok", b"<broken", "https://example.com", {"etag": "bad"}),
                        Result("error", error="HTTP 503")])
        validators = []
        def fetch(_, values):
            validators.append(deepcopy(values))
            return next(replies)
        scheduler, sink, _ = self.create(fetch)
        scheduler.start()
        first = self.round(sink)
        cache = scheduler.snapshot()
        for n in range(3):
            scheduler.refresh()
            body = self.round(sink)
            self.assertEqual(body["items"], first["items"])
            self.assertEqual(body["sources"][0]["ok"], n == 0)
            self.assertEqual(scheduler.snapshot(), cache)
        self.assertEqual(validators, [{}, {"etag": "new"}, {"etag": "new"}, {"etag": "new"}])

    def test_304_without_cache_clears_validators(self):
        scheduler, sink, _ = self.create(lambda *_: Result("not_modified"))
        scheduler.caches[0] = Cache(validators={"etag": "orphan"})
        scheduler.start()
        body = self.round(sink)
        self.assertEqual(body["sources"][0]["error"], "304 without cache")
        self.assertEqual(scheduler.snapshot()[0].validators, {})

    def test_fit_error_ends_round_and_next_refresh_survives(self):
        from back.feedparse import fit_packet
        calls = []
        def fit(packet):
            calls.append(1)
            if len(calls) == 1:
                raise ValueError("injected envelope overflow")
            return fit_packet(packet)
        scheduler, sink, logs = self.create(lambda *_: ok(), fit=fit)
        scheduler.start()
        eventually(lambda: scheduler.completed == 1)
        self.assertTrue(sink.packets.empty())
        self.assertIn("list packet rejected: injected envelope overflow", logs)
        self.assertTrue(scheduler.coordinator.is_alive())
        scheduler.refresh()
        self.assertEqual(len(self.round(sink)["items"]), 1)

    def test_publish_uses_fitted_count(self):
        from back.feedparse import fit_packet
        def trim(packet):
            packet["body"]["items"] = []
            return fit_packet(packet)
        scheduler, sink, _ = self.create(lambda *_: ok(), fit=trim)
        scheduler.start()
        self.assertEqual(self.round(sink)["items"], [])


@contextmanager
def feed_server(block=False):
    gate, entered = threading.Event(), threading.Event()
    if not block:
        gate.set()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass
        def do_GET(self):
            entered.set()
            gate.wait()
            try:
                data = ok().data_bytes
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=lambda: httpd.serve_forever(poll_interval=0.02), daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_port}/feed", entered, gate
    finally:
        gate.set()
        httpd.shutdown()
        httpd.server_close()
        thread.join(2)


class SchedulerProcessTests(unittest.TestCase):
    def harness(self, url, wrapper=None):
        harness = test_protocol.ProtocolTests(methodName="runTest")
        harness.setUp()
        self.addCleanup(harness.tearDown)
        feeds = harness.directory / "feeds.json"
        feeds.write_text(json.dumps([{"name": "Local", "url": url}]))
        harness.start(feeds=feeds, extra_args=["--allow-host", "127.0.0.1"],
                      scheduler_options={"interval": 10}, wrapper=wrapper)
        harness.hello()
        return harness

    def test_up_real_http_list_publish_then_done(self):
        with feed_server() as (url, entered, _):
            h = self.harness(url)
            self.assertFalse(entered.is_set())
            h.send("up")
            listing, publish = h.packet(), h.packet()
            self.assertTrue(entered.is_set())
            self.assertEqual(listing["body"]["op"], "list")
            self.assertEqual(listing["seq"], h.seq)
            self.assertEqual(len(listing["body"]["items"]), 1)
            self.assertEqual(publish["body"]["count"], 1)
            self.assertEqual(publish["topic"], "news.fetched")
            start = time.monotonic()
            h.send("bye")
            h.exited(start)
            self.assertEqual(h.tail(), [{"t": "done", "seq": h.seq}])

    def test_refresh_packets_coalesce_while_real_http_is_blocked(self):
        import select
        with feed_server(block=True) as (url, entered, gate):
            h = self.harness(url)
            h.send("up")
            self.assertTrue(entered.wait(2))
            refresh = {"t": "msg", "seq": h.seq, "body": {"op": "refresh"}}
            h.process.stdin.write(((json.dumps(refresh) + "\n") * 2).encode())
            # FIFO stdin barrier: both refresh packets handled before release.
            h.send("bye", h.seq + 1)
            h.marker("seq-discarded")
            self.assertFalse(gate.is_set())
            gate.set()
            packets = [h.packet() for _ in range(4)]
            self.assertEqual([p["t"] for p in packets], ["msg", "publish", "msg", "publish"])
            self.assertFalse(h.buffer)
            self.assertFalse(select.select([h.process.stdout], [], [], 0.1)[0])
            start = time.monotonic()
            h.send("bye")
            h.exited(start)
            self.assertEqual(h.tail(), [{"t": "done", "seq": h.seq}])

    def test_bye_and_eof_while_http_blocked_exit_within_second(self):
        for eof in (False, True):
            with self.subTest(eof=eof), feed_server(block=True) as (url, entered, gate):
                h = self.harness(url)
                h.send("up")
                self.assertTrue(entered.wait(2))
                self.assertFalse(gate.is_set())
                start = time.monotonic()
                if eof:
                    h.process.stdin.close()
                else:
                    h.send("bye")
                h.exited(start)
                self.assertEqual(h.tail(), [{"t": "done", "seq": h.seq}])

    def test_fit_valueerror_does_not_kill_process(self):
        wrapper = "from back import news; import sys; from functools import partial; " \
                  "bad = lambda p: (_ for _ in ()).throw(ValueError('forced-fit-error')); " \
                  "sys.exit(news.main(scheduler_factory=partial(news.Scheduler, fit=bad)))"
        with feed_server() as (url, entered, _):
            h = self.harness(url, wrapper)
            h.send("up")
            self.assertTrue(entered.wait(2))
            import select
            import os
            logs = b""
            end = time.monotonic() + 2
            while b"list packet rejected: forced-fit-error" not in logs:
                self.assertGreater(end - time.monotonic(), 0)
                self.assertTrue(select.select([h.process.stderr], [], [], end - time.monotonic())[0])
                logs += os.read(h.process.stderr.fileno(), 4096)
            self.assertIsNone(h.process.poll())
            start = time.monotonic()
            h.send("bye")
            h.exited(start)
            self.assertEqual(h.tail(), [{"t": "done", "seq": h.seq}])


class ClassificationSchedulerTests(unittest.TestCase):
    setUp = SchedulerTests.setUp
    tearDown = SchedulerTests.tearDown
    gate = SchedulerTests.gate
    create = SchedulerTests.create
    round = SchedulerTests.round

    def classifier(self, url):
        from back.classify import Classifier
        return Classifier(endpoint=url, key="test", log=lambda _: None)

    def cache(self, scheduler):
        with scheduler.cv:
            return dict(scheduler.classify_cache)

    def test_first_list_publish_then_each_batch_resends_without_publish(self):
        from tests.test_classify import server, answers
        first, second = self.gate(), self.gate()
        entered = threading.Event()
        def respond(payload, n, _):
            entered.set()
            (first if n == 1 else second).wait()
            return 200, answers(len(payload["state"])), {}
        data = ('<rss><channel>' + ''.join(
            f'<item><title>{i:02d}</title><link>https://example.com/{i}</link></item>'
            for i in range(21)) + '</channel></rss>').encode()
        with server(respond) as (url, received):
            scheduler, sink, _ = self.create(lambda *_: Result("ok", data, "https://example.com"),
                                             classifier=self.classifier(url))
            scheduler.start()
            try:
                initial = self.round(sink)
                self.assertEqual(initial["classify"], {"enabled": True, "pending": 21})
                self.assertTrue(all(i["category"] == "" for i in initial["items"]))
                self.assertTrue(entered.wait(1))
                self.assertTrue(sink.packets.empty())
                first.set()
                update = sink.packets.get(timeout=2)
                self.assertEqual(update["t"], "msg")
                self.assertEqual(update["body"]["classify"], {"enabled": True, "pending": 1})
                second.set()
                final = sink.packets.get(timeout=2)
                self.assertEqual(final["t"], "msg")
                self.assertEqual(final["body"]["classify"], {"enabled": True, "pending": 0})
                for packet in (update, final):
                    body = deepcopy(packet["body"])
                    self.assertEqual(body["at"], initial["at"])
                    body.pop("classify")
                    for item in body["items"]:
                        item["category"] = ""
                    expected = deepcopy(initial)
                    expected.pop("classify")
                    self.assertEqual(body, expected)
                eventually(lambda: not scheduler.in_flight)
                with self.assertRaises(queue.Empty):
                    sink.packets.get(timeout=0.05)
                self.assertEqual(len(received), 2)
                self.assertTrue(all("category" not in i for i in scheduler.snapshot()[0].items))
            finally:
                first.set()
                second.set()

    def test_cached_keys_make_zero_requests_next_round_only_new_key_requested(self):
        from tests.test_classify import server
        label = ["new"]
        with server() as (url, received):
            scheduler, sink, _ = self.create(lambda *_: ok(label[0]), classifier=self.classifier(url))
            scheduler.start()
            self.round(sink)
            self.assertEqual(sink.packets.get(timeout=2)["body"]["items"][0]["category"], "tech")
            scheduler.refresh()
            body = self.round(sink)
            self.assertEqual(body["classify"]["pending"], 0)
            eventually(lambda: scheduler.completed == 2)
            self.assertEqual(len(received), 1)
            label[0] = "fresh"
            scheduler.refresh()
            self.assertEqual(self.round(sink)["classify"]["pending"], 1)
            self.assertEqual(sink.packets.get(timeout=2)["body"]["items"][0]["category"], "tech")
            self.assertEqual(len(received), 2)
            self.assertEqual(received[1][2]["state"]["news_0"]["title"], "fresh")

    def test_cache_4000_fifo_only_success_and_evicted_key_is_requested(self):
        from back.scheduler import ClassifyResult
        from tests.test_classify import server
        with server() as (url, received):
            scheduler, sink, _ = self.create(lambda *_: ok(), classifier=self.classifier(url))
            with scheduler.cv:
                scheduler._accept(ClassifyResult({"https://example.com/new": "tech"}))
                scheduler._accept(ClassifyResult({f"key-{i}": "life" for i in range(3999)}))
                # Updating an existing key must not turn FIFO eviction into LRU.
                scheduler._accept(ClassifyResult({"https://example.com/new": "finance", "bad": "", "bad2": "zzz"}))
                self.assertEqual(len(scheduler.classify_cache), 4000)
                self.assertNotIn("bad", scheduler.classify_cache)
                self.assertNotIn("bad2", scheduler.classify_cache)
                scheduler._accept(ClassifyResult({"newest": "other"}))
                self.assertEqual(len(scheduler.classify_cache), 4000)
                self.assertNotIn("https://example.com/new", scheduler.classify_cache)
                self.assertEqual(next(iter(scheduler.classify_cache)), "key-0")
            scheduler.start()
            self.assertEqual(self.round(sink)["classify"]["pending"], 1)
            self.assertEqual(sink.packets.get(timeout=2)["body"]["classify"]["pending"], 0)
            self.assertEqual(len(received), 1)
            self.assertEqual(len(self.cache(scheduler)), 4000)
            self.assertNotIn("key-0", self.cache(scheduler))

    def test_old_classification_during_active_round_commits_without_resend(self):
        from tests.test_classify import server, answers
        classify_gate, fetch_gate = self.gate(), self.gate()
        classify_entered, fetch_entered = threading.Event(), threading.Event()
        calls = []
        def respond(payload, *_):
            classify_entered.set()
            classify_gate.wait()
            return 200, answers(len(payload["state"])), {}
        def fetch(*_):
            calls.append(1)
            if len(calls) == 2:
                fetch_entered.set()
                fetch_gate.wait()
            return ok()
        with server(respond) as (url, received):
            scheduler, sink, _ = self.create(fetch, classifier=self.classifier(url), source_timeout=3, round_timeout=4)
            scheduler.start()
            try:
                self.round(sink)
                self.assertTrue(classify_entered.wait(1))
                scheduler.refresh()
                self.assertTrue(fetch_entered.wait(1))
                with scheduler.cv:
                    self.assertTrue(scheduler.active)
                    self.assertEqual(scheduler.round_id, 2)
                classify_gate.set()
                eventually(lambda: self.cache(scheduler).get("https://example.com/new") == "tech")
                # Give the coordinator time to perform any forbidden resend.
                with self.assertRaises(queue.Empty):
                    sink.packets.get(timeout=0.05)
                fetch_gate.set()
                body = self.round(sink)
                self.assertEqual(body["items"][0]["category"], "tech")
                self.assertEqual(body["classify"]["pending"], 0)
                self.assertEqual(len(received), 1)
            finally:
                classify_gate.set()
                fetch_gate.set()

    def test_old_classification_after_new_round_resends_latest_list(self):
        from tests.test_classify import server, answers
        gate, entered = self.gate(), threading.Event()
        def respond(payload, *_):
            entered.set()
            gate.wait()
            return 200, answers(len(payload["state"])), {}
        with server(respond) as (url, received):
            scheduler, sink, _ = self.create(lambda *_: ok(), classifier=self.classifier(url))
            scheduler.start()
            try:
                self.round(sink)
                self.assertTrue(entered.wait(1))
                scheduler.refresh()
                second = self.round(sink)
                eventually(lambda: scheduler.completed == 2)
                gate.set()
                update = sink.packets.get(timeout=2)
                self.assertEqual(update["body"]["at"], second["at"])
                self.assertEqual(update["body"]["items"][0]["category"], "tech")
                self.assertEqual(len(received), 1)
            finally:
                gate.set()

    def test_no_key_or_none_starts_no_classification_thread(self):
        from back.classify import Classifier
        for classifier in (None, Classifier(key="", log=lambda _: None)):
            with self.subTest(classifier=classifier):
                scheduler, sink, _ = self.create(lambda *_: ok(), classifier=classifier)
                before = threading.active_count()
                scheduler.start()
                body = self.round(sink)
                self.assertEqual(threading.active_count(), before + 5)  # Four fetch + coordinator.
                self.assertIsNone(scheduler.classify_worker)
                self.assertEqual(body["classify"], {"enabled": False, "pending": 0})
                self.assertEqual(body["items"][0]["category"], "")
                scheduler.stop()
                for thread in scheduler.workers + [scheduler.coordinator]:
                    thread.join(1)

    def test_queue_200_nonblocking_and_inflight_dedup_queued_and_processing(self):
        from tests.test_classify import server, answers
        gate, entered = self.gate(), threading.Event()
        group = [("a", 1)]
        def fetch(*_):
            prefix, count = group[0]
            data = ('<rss><channel>' + ''.join(
                f'<item><title>{prefix}{i}</title><link>https://example.com/{prefix}{i}</link></item>'
                for i in range(count)) + '</channel></rss>').encode()
            return Result("ok", data, "https://example.com")
        def respond(payload, *_):
            entered.set()
            gate.wait()
            return 200, answers(len(payload["state"])), {}
        with server(respond) as (url, received):
            scheduler, sink, _ = self.create(fetch, classifier=self.classifier(url))
            before = threading.active_count()
            scheduler.start()
            try:
                self.round(sink)
                self.assertTrue(entered.wait(1))
                # Server adds one handler thread in addition to our six.
                self.assertEqual(threading.active_count(), before + 7)
                self.assertEqual(scheduler.classify_worker.name, "news-classify")
                self.assertTrue(scheduler.classify_worker.daemon)
                for n, (value, queued, flying) in enumerate([
                    (("a", 1), 0, 1),     # Already processing.
                    (("b", 100), 100, 101),
                    (("b", 100), 100, 101),  # Already queued, with free capacity.
                    (("c", 200), 200, 201),  # Overflow drops 100 without blocking.
                ], start=2):
                    group[0] = value
                    start = time.monotonic()
                    scheduler.refresh()
                    self.round(sink)
                    eventually(lambda: scheduler.completed == n)
                    self.assertLess(time.monotonic() - start, 0.5)
                    with scheduler.cv:
                        self.assertEqual(scheduler.classify_jobs.maxsize, 200)
                        self.assertEqual(scheduler.classify_jobs.qsize(), queued)
                        self.assertEqual(len(scheduler.in_flight), flying)
                self.assertEqual(len(received), 1)
            finally:
                scheduler.stop()
                gate.set()

    def test_failure_releases_inflight_and_next_round_retries(self):
        from tests.test_classify import server, answers
        with server(lambda p, n, _: (500, {}, {}) if n == 1 else (200, answers(len(p["state"])), {})) as (url, received):
            scheduler, sink, _ = self.create(lambda *_: ok(), classifier=self.classifier(url))
            scheduler.start()
            self.round(sink)
            eventually(lambda: len(received) == 1 and not scheduler.in_flight)
            self.assertEqual(self.cache(scheduler), {})
            self.assertTrue(sink.packets.empty())
            scheduler.refresh()
            self.round(sink)
            self.assertEqual(sink.packets.get(timeout=2)["body"]["items"][0]["category"], "tech")
            self.assertEqual(len(received), 2)

    def test_401_resends_disabled_state_and_never_retries(self):
        from tests.test_classify import server
        with server(lambda *_: (401, {}, {})) as (url, received):
            scheduler, sink, _ = self.create(lambda *_: ok(), classifier=self.classifier(url))
            scheduler.start()
            self.round(sink)
            body = sink.packets.get(timeout=2)["body"]
            self.assertEqual(body["classify"], {"enabled": False, "pending": 0})
            self.assertEqual(body["items"][0]["category"], "")
            scheduler.refresh()
            self.assertEqual(self.round(sink)["classify"], {"enabled": False, "pending": 0})
            eventually(lambda: scheduler.completed == 2)
            self.assertEqual(len(received), 1)

    def test_nonvisible_classification_cached_without_resend(self):
        from back.scheduler import ClassifyResult
        scheduler, sink, _ = self.create(lambda *_: ok())
        scheduler.start()
        self.round(sink)
        eventually(lambda: scheduler.completed == 1)
        with scheduler.cv:
            scheduler.results.append(ClassifyResult({"https://example.com/absent": "life"}, round_id=-1))
            scheduler.cv.notify_all()
        eventually(lambda: "https://example.com/absent" in self.cache(scheduler))
        with self.assertRaises(queue.Empty):
            sink.packets.get(timeout=0.05)

    def test_resend_uses_fit_and_preserves_items(self):
        from back.feedparse import fit_packet
        from back.scheduler import ClassifyResult
        calls = []
        def fit(packet):
            calls.append(deepcopy(packet))
            return fit_packet(packet)
        # Direct candidate injection isolates the resend path from HTTP timing.
        scheduler, sink, _ = self.create(lambda *_: ok(), fit=fit)
        scheduler.start()
        initial = self.round(sink)
        eventually(lambda: scheduler.completed == 1)
        with scheduler.cv:
            scheduler.results.append(ClassifyResult({"https://example.com/new": "entertainment"}))
            scheduler.cv.notify_all()
        update = sink.packets.get(timeout=2)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1]["body"]["items"][0]["category"], "entertainment")
        self.assertEqual(len(update["body"]["items"]), len(initial["items"]))
        self.assertEqual([i["link"] for i in update["body"]["items"]],
                         [i["link"] for i in initial["items"]])
        self.assertEqual(update["body"]["classify"]["pending"], 0)
        self.assertEqual(update["body"]["at"], initial["at"])
        with self.assertRaises(queue.Empty):
            sink.packets.get(timeout=0.05)


    def test_initial_emit_reserves_category_space_at_900_kib_boundary(self):
        from datetime import datetime, timezone
        from types import SimpleNamespace
        from back.feedparse import MAX_PACKET, packet_bytes
        from back.scheduler import ClassifyResult
        now = datetime(2026, 9, 22, tzinfo=timezone.utc)
        sink, logs = Sink(), []
        scheduler = Scheduler([{"name": "0", "url": "https://example.com/feed"}],
                              FunctionFetcher(lambda *_: ok()), sink, 891,
                              now=lambda: now, classifier=SimpleNamespace(enabled=True), log=logs.append)
        items = [dict(title="中" * 300, summary="文" * 200,
                      link=f"https://example.com/{i:03d}/", source="0",
                      published=now.isoformat(), time_guessed=False, category="")
                 for i in range(200)]
        sources = [{"name": "0", "ok": True, "error": None, "count": 200}]
        packet = {"t": "msg", "seq": 891, "body": {"op": "list", "items": items,
                  "sources": sources, "at": now.isoformat(),
                  "classify": {"enabled": True, "pending": 200}}}
        # Real bounded fields, no artificial oversized envelope padding.
        needed = MAX_PACKET - 1000 - len(packet_bytes(packet))
        self.assertGreater(needed, 0)
        for item in items:
            padding = min(needed, 2048 - len(item["link"]))
            item["link"] += "x" * padding
            needed -= padding
        self.assertEqual(needed, 0)
        self.assertEqual(len(packet_bytes(packet)), MAX_PACKET - 1000)
        classified = deepcopy(packet)
        for item in classified["body"]["items"]:
            item["category"] = "entertainment"
        classified["body"]["classify"]["pending"] = 0
        self.assertGreater(len(packet_bytes(classified)), MAX_PACKET)
        original = deepcopy(items)
        initial = scheduler._emit([Cache(items=items)], sources)
        first = self.round(sink)
        self.assertLess(len(first["items"]), 200)
        self.assertGreater(len(first["items"]), 0)
        self.assertTrue(all(i["category"] == "" for i in first["items"]))
        self.assertEqual(first["classify"]["pending"], len(first["items"]))
        self.assertEqual(items, original)
        with scheduler.cv:
            resend = scheduler._accept(ClassifyResult({i["link"]: "entertainment" for i in first["items"]}))
        scheduler._send_list(resend)
        update = sink.packets.get_nowait()
        self.assertEqual(update["t"], "msg")
        self.assertEqual([i["link"] for i in update["body"]["items"]],
                         [i["link"] for i in first["items"]])
        self.assertEqual(len(update["body"]["items"]), len(first["items"]))
        self.assertTrue(all(i["category"] == "entertainment" for i in update["body"]["items"]))
        self.assertEqual(update["body"]["classify"]["pending"], 0)
        self.assertEqual(update["body"]["at"], first["at"])
        self.assertLessEqual(len(packet_bytes(initial)), MAX_PACKET)
        self.assertLessEqual(len(packet_bytes(update)), MAX_PACKET)
        self.assertTrue(sink.packets.empty())
        self.assertEqual(logs, [])

    def test_unexpected_resend_trim_logs_and_still_sends(self):
        from back.feedparse import fit_packet
        from back.scheduler import ClassifyResult
        calls = []
        def broken_fit(packet):
            calls.append(1)
            if len(calls) == 2:
                packet["body"]["items"] = []
            return fit_packet(packet)
        scheduler, sink, logs = self.create(lambda *_: ok(), fit=broken_fit)
        scheduler.start()
        self.round(sink)
        eventually(lambda: scheduler.completed == 1)
        with scheduler.cv:
            scheduler.results.append(ClassifyResult({"https://example.com/new": "entertainment"}))
            scheduler.cv.notify_all()
        update = sink.packets.get(timeout=2)
        self.assertEqual(update["body"]["items"], [])
        self.assertEqual(logs.count("classify: resend unexpectedly trimmed items"), 1)
        self.assertTrue(scheduler.coordinator.is_alive())
