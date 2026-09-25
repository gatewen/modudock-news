from contextlib import contextmanager
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import queue
import threading
import time
import unittest

from back.feedparse import MAX_ITEMS_LIST
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
                    self.assertEqual(body.pop("analysis")["pending"],
                                     sum(i["category"] in {"finance", "tech"} for i in body["items"]))
                    for item in body["items"]:
                        item["category"] = ""
                    expected = deepcopy(initial)
                    expected.pop("classify")
                    expected.pop("analysis")
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

    def test_queue_list_limit_nonblocking_and_inflight_dedup_queued_and_processing(self):
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
                    (("c", MAX_ITEMS_LIST), MAX_ITEMS_LIST, MAX_ITEMS_LIST + 1),  # Overflow drops 100 without blocking.
                ], start=2):
                    group[0] = value
                    start = time.monotonic()
                    scheduler.refresh()
                    self.round(sink)
                    eventually(lambda: scheduler.completed == n)
                    self.assertLess(time.monotonic() - start, 0.5)
                    with scheduler.cv:
                        self.assertEqual(scheduler.classify_jobs.maxsize, MAX_ITEMS_LIST)
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


def analysis_feed(labels):
    data = ('<rss><channel>' + ''.join(
        f'<item><title>{label}</title><link>https://example.com/{label}</link></item>'
        for label in labels) + '</channel></rss>').encode()
    return Result("ok", data, "https://example.com")


def model_answers(payload):
    from tests.test_analyze import answers as analysis_answers
    if "market_0" in payload["questions"]:
        return analysis_answers(len(payload["state"]))
    return {"answers": {f"item_{i}": {"choice": item["title"].split('-')[0],
                         "probabilities": {item["title"].split('-')[0]: 0.9}}
                         for i, item in enumerate(payload["state"].values())}}


def model_kind(payload):
    return "analysis" if "market_0" in payload["questions"] else "classification"


class AnalysisSchedulerTests(unittest.TestCase):
    setUp = SchedulerTests.setUp
    tearDown = SchedulerTests.tearDown
    gate = SchedulerTests.gate
    create = SchedulerTests.create
    round = SchedulerTests.round

    def clients(self, url, **options):
        from back.classify import Classifier
        from back.analyze import Analyzer
        classifier = Classifier(endpoint=url, key="analysis-integration-secret", log=lambda _: None, **options)
        analyzer = Analyzer(shared=classifier)
        self.assertIs(analyzer._opener, classifier._opener)
        self.assertIs(analyzer.ssl_context, classifier.ssl_context)
        return {"classifier": classifier, "analyzer": analyzer}

    def cache(self, scheduler):
        with scheduler.cv:
            return deepcopy(scheduler.analysis_cache)

    def idle(self, scheduler):
        with scheduler.cv:
            return not scheduler.in_flight and not scheduler.analysis_in_flight

    def next_analysis(self, sink):
        packet = sink.packets.get(timeout=2)
        self.assertEqual(packet["t"], "msg")
        self.assertEqual(packet["body"]["op"], "list")
        return packet["body"]

    def test_finance_tech_analysis_resend_and_other_categories_null(self):
        from tests.test_classify import server
        with server(lambda p, *_: (200, model_answers(p), {})) as (url, received):
            scheduler, sink, _ = self.create(lambda *_: analysis_feed(['finance-a', 'tech-b', 'society-c']), **self.clients(url))
            scheduler.start()
            initial = self.round(sink)
            self.assertEqual(initial["analysis"], {"pending": 0})
            self.assertTrue(all(i["analysis"] is None for i in initial["items"]))
            classified = self.next_analysis(sink)
            self.assertEqual(classified["analysis"], {"pending": 2})
            final = self.next_analysis(sink)
            self.assertEqual(final["analysis"], {"pending": 0})
            self.assertEqual(final["at"], initial["at"])
            self.assertEqual([i["link"] for i in final["items"]], [i["link"] for i in initial["items"]])
            for item in final["items"]:
                if item["category"] in {'finance', 'tech'}:
                    self.assertEqual(item["analysis"], {"kind": "finance", "market": "positive", "theme": "memory", "dir": "bull", "dir_p": 0.8})
                else:
                    self.assertIsNone(item["analysis"])
            self.assertEqual([model_kind(p) for _, _, p in received], ['classification', 'analysis'])
            self.assertEqual(len(received[1][2]["state"]), 2)
            eventually(lambda: self.idle(scheduler))
            with self.assertRaises(queue.Empty):
                sink.packets.get(timeout=0.05)
            self.assertTrue(all('analysis' not in i for i in scheduler.snapshot()[0].items))

    def test_nonfinancial_cached_category_never_sends_analysis(self):
        from tests.test_classify import server
        with server(lambda p, *_: (200, model_answers(p), {})) as (url, received):
            scheduler, sink, _ = self.create(lambda *_: analysis_feed(['society-a']), **self.clients(url))
            with scheduler.cv:
                scheduler.classify_cache['https://example.com/society-a'] = 'society'
            scheduler.start()
            body = self.round(sink)
            self.assertIsNone(body['items'][0]['analysis'])
            self.assertEqual(body['analysis']['pending'], 0)
            eventually(lambda: scheduler.completed == 1)
            with self.assertRaises(queue.Empty):
                sink.packets.get(timeout=0.05)
            self.assertEqual(received, [])
            self.assertEqual(self.cache(scheduler), {})

    def test_emit_schedules_cached_category_and_analysis_cache_hit_zero_requests(self):
        from tests.test_classify import server
        with server(lambda p, *_: (200, model_answers(p), {})) as (url, received):
            scheduler, sink, _ = self.create(lambda *_: analysis_feed(['finance-a']), **self.clients(url))
            with scheduler.cv:
                scheduler.classify_cache['https://example.com/finance-a'] = 'finance'
            scheduler.start()
            self.assertEqual(self.round(sink)['analysis']['pending'], 1)
            self.assertEqual(self.next_analysis(sink)['analysis']['pending'], 0)
            self.assertEqual([model_kind(p) for _, _, p in received], ['analysis'])
            scheduler.refresh()
            body = self.round(sink)
            self.assertIsNotNone(body['items'][0]['analysis'])
            eventually(lambda: scheduler.completed == 2)
            self.assertEqual(len(received), 1)

    def test_analysis_fifo_4000_success_only_and_evicted_key_requeried(self):
        from back.scheduler import AnalysisResult
        from tests.test_classify import server
        value = {'market': 'positive', 'theme': 'memory', 'dir': 'bull', 'dir_p': 0.9}
        with server(lambda p, *_: (200, model_answers(p), {})) as (url, received):
            scheduler, sink, _ = self.create(lambda *_: analysis_feed(['finance-a']), **self.clients(url))
            key = 'https://example.com/finance-a'
            with scheduler.cv:
                scheduler.classify_cache[key] = 'finance'
                scheduler._accept(AnalysisResult({key: value}))
                scheduler._accept(AnalysisResult({f'key-{i}': value for i in range(3999)}))
                scheduler._accept(AnalysisResult({key: value, 'bad': None, 'bad2': {**value, 'dir_p': True}}))
                self.assertEqual(len(scheduler.analysis_cache), 4000)
                scheduler._accept(AnalysisResult({'latest': value}))
                self.assertNotIn(key, scheduler.analysis_cache)
                self.assertNotIn('bad', scheduler.analysis_cache)
                self.assertNotIn('bad2', scheduler.analysis_cache)
                self.assertEqual(next(iter(scheduler.analysis_cache)), 'key-0')
            scheduler.start()
            self.round(sink)
            self.next_analysis(sink)
            self.assertEqual(len(received), 1)
            self.assertEqual(len(self.cache(scheduler)), 4000)
            self.assertNotIn('key-0', self.cache(scheduler))

    def test_analysis_failure_releases_all_keys_and_stops_round_then_retries(self):
        from tests.test_classify import server
        attempts = []
        def respond(payload, *_):
            if model_kind(payload) == 'analysis':
                attempts.append(1)
                if len(attempts) == 1:
                    return 500, {}, {}
            return 200, model_answers(payload), {}
        with server(respond) as (url, received):
            scheduler, sink, _ = self.create(lambda *_: analysis_feed([f'finance-{i}' for i in range(21)]), **self.clients(url))
            scheduler.start()
            self.round(sink)
            self.next_analysis(sink)
            self.next_analysis(sink)
            eventually(lambda: len(attempts) == 1 and self.idle(scheduler))
            self.assertEqual(self.cache(scheduler), {})
            self.assertEqual(len(received), 3)
            self.assertTrue(sink.packets.empty())
            scheduler.refresh()
            self.round(sink)
            self.next_analysis(sink)
            self.next_analysis(sink)
            eventually(lambda: self.idle(scheduler))
            self.assertEqual(len(attempts), 3)
            self.assertEqual(len(self.cache(scheduler)), 21)

    def test_auth_failure_in_either_client_disables_both_permanently(self):
        from tests.test_classify import server
        for stage in ('classification', 'analysis'):
            for status in (401, 403):
                with self.subTest(stage=stage, status=status):
                    def respond(payload, *_):
                        return (status, {}, {}) if model_kind(payload) == stage else (200, model_answers(payload), {})
                    with server(respond) as (url, received):
                        clients = self.clients(url)
                        scheduler, sink, _ = self.create(lambda *_: analysis_feed(['finance-a']), **clients)
                        scheduler.start()
                        self.round(sink)
                        if stage == 'analysis':
                            self.next_analysis(sink)
                        body = self.next_analysis(sink)
                        self.assertFalse(clients['classifier'].enabled)
                        self.assertFalse(clients['analyzer'].enabled)
                        self.assertEqual(body['classify'], {'enabled': False, 'pending': 0})
                        self.assertEqual(body['analysis']['pending'], 0)
                        self.assertTrue(all(i['analysis'] is None for i in body['items']))
                        count = len(received)
                        self.assertIsNone(clients['classifier'].classify([('x', 'title', '')]))
                        self.assertIsNone(clients['analyzer'].analyze([('x', 'title', '')]))
                        scheduler.refresh()
                        self.round(sink)
                        eventually(lambda: scheduler.completed == 2)
                        self.assertEqual(len(received), count)
                        scheduler.stop()

    def test_analysis_from_old_round_during_fetch_commits_without_resend(self):
        from tests.test_classify import server
        agate, fgate = self.gate(), self.gate()
        aentered, fentered = threading.Event(), threading.Event()
        calls = []
        def fetch(*_):
            calls.append(1)
            if len(calls) == 2:
                fentered.set()
                fgate.wait()
            return analysis_feed(['finance-a'])
        def respond(payload, *_):
            if model_kind(payload) == 'analysis':
                aentered.set()
                agate.wait()
            return 200, model_answers(payload), {}
        with server(respond) as (url, received):
            scheduler, sink, _ = self.create(fetch, source_timeout=3, round_timeout=4, **self.clients(url))
            scheduler.start()
            try:
                self.round(sink)
                self.next_analysis(sink)
                self.assertTrue(aentered.wait(1))
                scheduler.refresh()
                self.assertTrue(fentered.wait(1))
                self.assertEqual(scheduler.round_id, 2)
                agate.set()
                eventually(lambda: len(self.cache(scheduler)) == 1)
                with self.assertRaises(queue.Empty):
                    sink.packets.get(timeout=0.05)
                fgate.set()
                self.assertIsNotNone(self.round(sink)['items'][0]['analysis'])
                self.assertEqual(len(received), 2)
            finally:
                agate.set()
                fgate.set()

    def test_classification_preempts_remaining_analysis_at_batch_boundary(self):
        from tests.test_classify import server
        gate, entered = self.gate(), threading.Event()
        labels = [[f'finance-{i}' for i in range(21)]]
        def respond(payload, n, _):
            if n == 1:
                entered.set()
                gate.wait()
            return 200, model_answers(payload), {}
        with server(respond) as (url, received):
            scheduler, sink, _ = self.create(lambda *_: analysis_feed(labels[0]), **self.clients(url))
            with scheduler.cv:
                for label in labels[0]:
                    scheduler.classify_cache['https://example.com/' + label] = 'finance'
            scheduler.start()
            try:
                self.round(sink)
                self.assertTrue(entered.wait(1))
                labels[0] = ['tech-new']
                scheduler.refresh()
                self.round(sink)
                eventually(lambda: scheduler.completed == 2)
                with scheduler.cv:
                    self.assertEqual(scheduler.classify_jobs.qsize(), 1)
                    self.assertEqual(scheduler.analysis_jobs.qsize(), 1)
                gate.set()
                eventually(lambda: len(received) >= 3)
                self.assertEqual([model_kind(p) for _, _, p in received[:3]], ['analysis', 'classification', 'analysis'])
            finally:
                gate.set()

    def test_shared_budget_40_seconds_classify_20_analyze_no_third_request(self):
        from tests.test_classify import server
        now = [0]
        labels = [f'finance-{i:02d}' for i in range(22)]
        def respond(payload, *_):
            now[0] += 40 if model_kind(payload) == 'classification' else 20
            return 200, model_answers(payload), {}
        with server(respond) as (url, received):
            scheduler, sink, _ = self.create(lambda *_: analysis_feed(labels), **self.clients(url, clock=lambda: now[0], read_deadline=120))
            with scheduler.cv:
                for label in labels[:21]:
                    scheduler.classify_cache['https://example.com/' + label] = 'finance'
            scheduler.start()
            self.round(sink)
            self.next_analysis(sink)
            self.next_analysis(sink)
            eventually(lambda: self.idle(scheduler))
            self.assertEqual([model_kind(p) for _, _, p in received], ['classification', 'analysis'])
            self.assertEqual(now[0], 60)
            self.assertEqual(len(self.cache(scheduler)), 20)
            scheduler.refresh()
            self.assertEqual(self.round(sink)['analysis']['pending'], 2)
            self.assertEqual(self.next_analysis(sink)['analysis']['pending'], 0)
            self.assertEqual(len(received), 3)
            self.assertEqual(len(received[-1][2]['state']), 2)

    def test_classification_exhausts_budget_analysis_waits_next_round(self):
        from tests.test_classify import server
        now = [0]
        def respond(payload, *_):
            now[0] += 60
            return 200, model_answers(payload), {}
        with server(respond) as (url, received):
            scheduler, sink, _ = self.create(lambda *_: analysis_feed(['finance-a']), **self.clients(url, clock=lambda: now[0], read_deadline=120))
            scheduler.start()
            self.round(sink)
            self.next_analysis(sink)
            eventually(lambda: self.idle(scheduler))
            self.assertEqual(len(received), 1)
            self.assertEqual(self.cache(scheduler), {})
            scheduler.refresh()
            self.round(sink)
            self.assertEqual(self.next_analysis(sink)['analysis']['pending'], 0)
            self.assertEqual(len(received), 2)

    def test_classification_failure_also_stops_cached_analysis_same_round(self):
        from tests.test_classify import server
        with server(lambda p, n, _: (500, {}, {}) if n == 1 else (200, model_answers(p), {})) as (url, received):
            scheduler, sink, _ = self.create(lambda *_: analysis_feed(['finance-a', 'tech-new']), **self.clients(url))
            with scheduler.cv:
                scheduler.classify_cache['https://example.com/finance-a'] = 'finance'
            scheduler.start()
            self.round(sink)
            eventually(lambda: len(received) == 1 and self.idle(scheduler))
            self.assertEqual(self.cache(scheduler), {})
            scheduler.refresh()
            self.round(sink)
            eventually(lambda: len(self.cache(scheduler)) == 2)
            self.assertGreaterEqual(len(received), 3)

    def test_analysis_queue_bounded_and_deduplicates_queued_processing_keys(self):
        from tests.test_classify import server
        gate, entered = self.gate(), threading.Event()
        labels = [['finance-a']]
        def respond(payload, *_):
            entered.set()
            gate.wait()
            return 200, model_answers(payload), {}
        with server(respond) as (url, received):
            scheduler, sink, _ = self.create(lambda *_: analysis_feed(labels[0]), **self.clients(url))
            with scheduler.cv:
                for label in ['finance-a'] + [f'finance-b{i}' for i in range(100)] + [f'finance-c{i}' for i in range(MAX_ITEMS_LIST)]:
                    scheduler.classify_cache['https://example.com/' + label] = 'finance'
            scheduler.start()
            try:
                self.round(sink)
                self.assertTrue(entered.wait(1))
                for round_id, (group, queued) in enumerate([
                    (['finance-a'], 0),
                    ([f'finance-b{i}' for i in range(100)], 100),
                    ([f'finance-b{i}' for i in range(100)], 100),
                    ([f'finance-c{i}' for i in range(MAX_ITEMS_LIST)], MAX_ITEMS_LIST),
                ], start=2):
                    labels[0] = group
                    scheduler.refresh()
                    self.round(sink)
                    eventually(lambda: scheduler.completed == round_id)
                    with scheduler.cv:
                        self.assertEqual(scheduler.analysis_jobs.maxsize, MAX_ITEMS_LIST)
                        self.assertEqual(scheduler.analysis_jobs.qsize(), queued)
                        self.assertEqual(len(scheduler.analysis_in_flight), queued + 1)
                self.assertEqual(len(received), 1)
            finally:
                scheduler.stop()
                gate.set()

    def test_300_items_always_have_analysis_even_without_key(self):
        scheduler, sink, _ = self.create(lambda *_: analysis_feed([f'society-{i}' for i in range(305)]))
        scheduler.start()
        body = self.round(sink)
        self.assertEqual(len(body['items']), 300)
        self.assertTrue(all('analysis' in i and i['analysis'] is None for i in body['items']))
        self.assertEqual(body['analysis']['pending'], 0)

    def test_analysis_reserve_boundary_preserves_links_through_both_resends(self):
        from datetime import datetime, timezone
        from back.scheduler import ClassifyResult, AnalysisResult
        from back.feedparse import MAX_PACKET, packet_bytes
        now = datetime(2026, 9, 23, tzinfo=timezone.utc)
        sink, logs = Sink(), []
        clients = self.clients('http://127.0.0.1:9/')
        scheduler = Scheduler([{'name': '0', 'url': 'https://example.com'}],
                              FunctionFetcher(lambda *_: ok()), sink, 891,
                              now=lambda: now, log=logs.append, **clients)
        items = [dict(title='中' * 300, summary='文' * 200,
                      link=f'https://example.com/{i:03d}/', source='0',
                      published=now.isoformat(), time_guessed=False, category='', analysis=None)
                 for i in range(200)]
        sources = [{'name': '0', 'ok': True, 'error': None, 'count': 200}]
        packet = {'t': 'msg', 'seq': 891, 'body': {'op': 'list', 'items': items,
                  'sources': sources, 'at': now.isoformat(),
                  'classify': {'enabled': True, 'pending': 200}, 'analysis': {'pending': 0}}}
        # Leaves room for all category ids but not the pending analyses.
        needed = MAX_PACKET - 13 * 200 - 1000 - len(packet_bytes(packet))
        self.assertGreater(needed, 0)
        for item in items:
            padding = min(needed, 2048 - len(item['link']))
            item['link'] += 'x' * padding
            needed -= padding
        self.assertEqual(needed, 0)
        self.assertLessEqual(len(packet_bytes(packet)) + 13 * 200, MAX_PACKET)
        value = {'market': 'not_market', 'theme': 'consumer_elec', 'dir': 'neutral', 'dir_p': 0.99}
        filled = deepcopy(packet)
        for item in filled['body']['items']:
            item.update(category='finance', analysis=deepcopy(value))
        filled['body']['classify']['pending'] = 0
        self.assertGreater(len(packet_bytes(filled)), MAX_PACKET)
        scheduler._emit([Cache(items=items)], sources)
        initial = self.round(sink)
        self.assertLess(len(initial['items']), 200)
        self.assertGreater(len(initial['items']), 0)
        keys = [i['link'] for i in initial['items']]
        with scheduler.cv:
            resend = scheduler._accept(ClassifyResult({key: 'finance' for key in keys}))
        scheduler._send_list(resend)
        classified = self.next_analysis(sink)
        self.assertEqual(classified['analysis']['pending'], len(keys))
        with scheduler.cv:
            resend = scheduler._accept(AnalysisResult({key: value for key in keys}, round_id=-123))
        scheduler._send_list(resend)
        final = self.next_analysis(sink)
        self.assertEqual(final['analysis']['pending'], 0)
        for body in (classified, final):
            self.assertEqual([i['link'] for i in body['items']], keys)
            self.assertEqual(len(body['items']), len(initial['items']))
            self.assertEqual(body['at'], initial['at'])
            self.assertLessEqual(len(packet_bytes({'t': 'msg', 'seq': 891, 'body': body})), MAX_PACKET)
        self.assertTrue(all(i['analysis'] is None and i['category'] == '' for i in items))
        self.assertTrue(all(i['analysis'] == value for i in final['items']))
        self.assertEqual(logs, [])
        self.assertTrue(sink.packets.empty())

    def test_analysis_pending_recount_after_fit_and_when_disabled(self):
        from back.feedparse import fit_packet, MAX_PACKET, packet_bytes
        items = [dict(title='中' * 300, summary='文' * 200,
                      link='https://example.com/' + 'x' * 2028, source='0',
                      published='2026-09-23', category='finance' if i % 2 else 'society', analysis=None)
                 for i in range(300)]
        packet = {'t': 'msg', 'seq': 42, 'body': {'items': items,
                  'classify': {'enabled': True, 'pending': 0}, 'analysis': {'pending': 150}}}
        self.assertGreater(len(packet_bytes(packet)), MAX_PACKET)
        fitted = fit_packet(packet)
        self.assertLess(len(fitted['body']['items']), 300)
        self.assertEqual(fitted['body']['analysis']['pending'],
                         sum(i['category'] == 'finance' for i in fitted['body']['items']))
        self.assertLess(fitted['body']['analysis']['pending'], 150)
        packet['body']['classify']['enabled'] = False
        self.assertEqual(fit_packet(packet)['body']['analysis']['pending'], 0)

    def test_old_analysis_after_new_round_resends_latest_at(self):
        from tests.test_classify import server
        gate, entered = self.gate(), threading.Event()
        def respond(payload, *_):
            if model_kind(payload) == 'analysis':
                entered.set()
                gate.wait()
            return 200, model_answers(payload), {}
        with server(respond) as (url, received):
            scheduler, sink, _ = self.create(lambda *_: analysis_feed(['finance-a']), **self.clients(url))
            scheduler.start()
            try:
                self.round(sink)
                self.next_analysis(sink)
                self.assertTrue(entered.wait(1))
                scheduler.refresh()
                second = self.round(sink)
                eventually(lambda: scheduler.completed == 2)
                gate.set()
                final = self.next_analysis(sink)
                self.assertEqual(final['at'], second['at'])
                self.assertEqual(final['analysis']['pending'], 0)
                self.assertEqual(len(received), 2)
            finally:
                gate.set()


    def test_300_items_classified_and_analyzed_in_first_round(self):
        self.complete_full_model_round(cached_categories=False)

    def test_300_cached_categories_analyzed_in_first_round(self):
        self.complete_full_model_round(cached_categories=True)

    def complete_full_model_round(self, cached_categories):
        from tests.test_classify import server
        self.assertEqual(MAX_ITEMS_LIST, 300)
        labels = [f'finance-{i:03d}' for i in range(MAX_ITEMS_LIST)]
        with server(lambda p, *_: (200, model_answers(p), {})) as (url, received):
            scheduler, sink, _ = self.create(lambda *_: analysis_feed(labels), **self.clients(url))
            if cached_categories:
                with scheduler.cv:
                    scheduler.classify_cache.update({'https://example.com/' + label: 'finance' for label in labels})
            scheduler.start()
            first = self.round(sink)
            self.assertEqual(len(first['items']), MAX_ITEMS_LIST)
            self.assertEqual(first['classify']['pending'], 0 if cached_categories else MAX_ITEMS_LIST)
            def complete():
                with scheduler.cv:
                    return (scheduler.completed == 1 and scheduler.last_list is not None
                            and scheduler.last_list['body']['classify']['pending'] == 0
                            and scheduler.last_list['body']['analysis']['pending'] == 0)
            eventually(complete, timeout=4)
            with scheduler.cv:
                final = deepcopy(scheduler.last_list['body'])
                self.assertEqual(scheduler.round_id, 1)
                self.assertEqual(len(scheduler.classify_cache), MAX_ITEMS_LIST)
                self.assertEqual(len(scheduler.analysis_cache), MAX_ITEMS_LIST)
            self.assertTrue(all(i['category'] == 'finance' and i['analysis'] is not None for i in final['items']))
            self.assertEqual(final['at'], first['at'])
            self.assertEqual([i['link'] for i in final['items']], [i['link'] for i in first['items']])
            for kind, expected in [('classification', 0 if cached_categories else MAX_ITEMS_LIST),
                                   ('analysis', MAX_ITEMS_LIST)]:
                self.assertEqual(sum(len(p['state']) for _, _, p in received if model_kind(p) == kind), expected)
            while not sink.packets.empty():
                self.assertEqual(sink.packets.get_nowait()['t'], 'msg')  # No second publish.

    def test_world_and_finance_analyze_separately_other_categories_never_analyzed(self):
        from tests.test_classify import server
        from tests.test_analyze import world_answers
        labels = ['finance-a', 'world-b', 'tech-c', 'world-d', 'politics-e', 'society-f',
                  'life-g', 'sports-h', 'entertainment-i', 'other-j']
        def respond(payload, *_):
            body = world_answers(len(payload['state'])) if 'trend_0' in payload['questions'] else model_answers(payload)
            return 200, body, {}
        with server(respond) as (url, received):
            scheduler, sink, _ = self.create(lambda *_: analysis_feed(labels), **self.clients(url))
            scheduler.start()
            initial = self.round(sink)
            eventually(lambda: self.idle(scheduler) and scheduler.last_list['body']['classify']['pending'] == 0
                       and scheduler.last_list['body']['analysis']['pending'] == 0)
            with scheduler.cv:
                final = deepcopy(scheduler.last_list['body'])
            for item in final['items']:
                if item['category'] == 'world':
                    self.assertEqual(item['analysis'], {'kind': 'world', 'trend': 'escalation', 'region': 'asia_pacific'})
                elif item['category'] in {'finance', 'tech'}:
                    self.assertEqual(item['analysis']['kind'], 'finance')
                else:
                    self.assertIsNone(item['analysis'])
            analyzed = []
            for _, _, payload in received[1:]:
                world = 'trend_0' in payload['questions']
                titles = [i['title'] for i in payload['state'].values()]
                self.assertTrue(all(title.split('-')[0] in ({'world'} if world else {'finance', 'tech'}) for title in titles))
                analyzed.extend(titles)
                self.assertFalse('trend_0' in payload['questions'] and 'market_0' in payload['questions'])
            self.assertCountEqual(analyzed, labels[:4])
            updates = []
            while not sink.packets.empty():
                packet = sink.packets.get_nowait()
                self.assertEqual(packet['t'], 'msg')
                self.assertEqual(packet['body']['at'], initial['at'])
                updates.append(packet['body'])
            self.assertTrue(any(body['analysis']['pending'] == 4 for body in updates))
            self.assertTrue(any(any(i['category'] == 'world' and i['analysis'] for i in body['items']) for body in updates))

    def test_cached_world_category_schedules_analysis_and_cache_hit_skips_http(self):
        from tests.test_classify import server
        from tests.test_analyze import world_answers
        with server(lambda p, *_: (200, world_answers(len(p['state'])), {})) as (url, received):
            scheduler, sink, _ = self.create(lambda *_: analysis_feed(['world-a']), **self.clients(url))
            scheduler.classify_cache['https://example.com/world-a'] = 'world'
            scheduler.start()
            initial = self.round(sink)
            self.assertEqual(initial['analysis']['pending'], 1)
            final = self.next_analysis(sink)
            self.assertEqual(final['analysis']['pending'], 0)
            self.assertEqual(final['items'][0]['analysis']['kind'], 'world')
            eventually(lambda: self.idle(scheduler))
            scheduler.refresh()
            self.assertEqual(self.round(sink)['analysis']['pending'], 0)
            self.assertEqual(len(received), 1)

    def test_world_size_reserve_uses_larger_shape_and_preserves_resend_items(self):
        from back.analyze import QUESTIONS, WORLD_QUESTIONS
        from back.feedparse import ANALYSIS_RESERVE, MAX_PACKET, packet_bytes
        from back.scheduler import Cache, AnalysisResult
        from hashlib import sha1
        longest_finance = {name: max(criteria, key=len) for name, (_, criteria, _) in QUESTIONS.items()}
        longest_finance.update(kind='finance', dir_p=.99)
        longest_world = {name: max(criteria, key=len) for name, (_, criteria, _) in WORLD_QUESTIONS.items()}
        longest_world['kind'] = 'world'
        self.assertEqual(ANALYSIS_RESERVE, max(len(json.dumps(longest_finance)), len(json.dumps(longest_world))) - len('null'))
        scheduler, sink, logs = self.create(lambda *_: ok(), **self.clients('http://127.0.0.1:9'))
        self.schedulers.remove(scheduler)  # No threads are started in this boundary test.
        items = [dict(title=sha1(str(i).encode()).hexdigest(), summary='', link=f'https://example.com/{i}',
                      source='0', published='2026-09-24T00:00:00Z') for i in range(MAX_ITEMS_LIST)]
        with scheduler.cv:
            scheduler.classify_cache.update({i['link']: 'world' for i in items})
            packet = scheduler._decorate({'t': 'msg', 'seq': 891, 'body': {'op': 'list', 'items': items, 'sources': [], 'at': 'fixed'}})
        allowance = MAX_PACKET - len(packet_bytes(packet)) - 1000
        packet['body']['padding'] = 'x' * (allowance - len(', "padding": ""'))
        self.assertLessEqual(len(packet_bytes(packet)), MAX_PACKET)
        filled = deepcopy(packet)
        for item in filled['body']['items']:
            item['analysis'] = longest_world
        self.assertGreater(len(packet_bytes(filled)), MAX_PACKET)
        scheduler._send_list(packet, publish=True)
        initial = self.round(sink)
        self.assertLess(len(initial['items']), MAX_ITEMS_LIST)
        self.assertEqual(initial['analysis']['pending'], len(initial['items']))
        with scheduler.cv:
            update = scheduler._accept(AnalysisResult({i['link']: longest_world for i in initial['items']}))
        scheduler._send_list(update)
        final = self.next_analysis(sink)
        self.assertEqual([i['link'] for i in final['items']], [i['link'] for i in initial['items']])
        self.assertEqual(final['analysis']['pending'], 0)
        self.assertTrue(all(i['analysis'] == longest_world for i in final['items']))
        self.assertEqual(logs, [])


class AnalysisKindBatchTests(unittest.TestCase):
    def run_batches(self, entries):
        from types import SimpleNamespace
        calls, remaining = [], []
        def analyze(batch, *, kind):
            calls.append((kind, [item[0] for item in batch]))
            with scheduler.analysis_jobs.mutex:
                remaining.append([item[0] for _, item in scheduler.analysis_jobs.queue])
            return {}
        scheduler = Scheduler([{'name': 'A', 'url': 'unused'}], None, None, 1,
                              classifier=SimpleNamespace(enabled=True),
                              analyzer=SimpleNamespace(enabled=True, analyze=analyze))
        for work, key, category, title in entries:
            scheduler.classify_cache[key] = category
            scheduler.analysis_jobs.put_nowait((work, (key, title, '')))
        scheduler._submit_classification = lambda _: not scheduler.analysis_jobs.empty()
        scheduler._classify_worker()
        return calls, remaining

    def test_300_interleaved_items_take_16_requests_and_preserve_remaining_order(self):
        from back.scheduler import ModelRound
        work = ModelRound(1)
        entries = [(work, str(i), 'finance' if i % 2 == 0 else 'world', 'short') for i in range(300)]
        calls, remaining = self.run_batches(entries)
        self.assertEqual(len(calls), 16)  # ceil(150 / 20) for each kind.
        self.assertEqual([len(keys) for kind, keys in calls if kind == 'finance'], [20] * 7 + [10])
        self.assertEqual([len(keys) for kind, keys in calls if kind == 'world'], [20] * 7 + [10])
        queued = [str(i) for i in range(300)]
        for (kind, keys), rest in zip(calls, remaining):
            self.assertTrue(all((int(key) % 2 == 0) == (kind == 'finance') for key in keys))
            queued = [key for key in queued if key not in keys]
            self.assertEqual(rest, queued)
        self.assertEqual(queued, [])

    def test_scanning_respects_character_limit_and_keeps_skipped_kind(self):
        from back.scheduler import ModelRound
        work = ModelRound(1)
        calls, remaining = self.run_batches([(work, 'a', 'finance', 'x' * 4000),
            (work, 'b', 'world', 'short'), (work, 'c', 'tech', 'x' * 4000),
            (work, 'd', 'finance', 'x')])
        self.assertEqual(calls, [('finance', ['a', 'c']), ('world', ['b']), ('finance', ['d'])])
        self.assertEqual(remaining[0], ['b', 'd'])

    def test_scanning_does_not_cross_work_boundary(self):
        from back.scheduler import ModelRound
        first, second = ModelRound(1), ModelRound(2)
        calls, _ = self.run_batches([(first, 'a', 'finance', 'short'),
            (first, 'b', 'world', 'short'), (second, 'c', 'finance', 'short')])
        self.assertEqual(calls, [('finance', ['a']), ('world', ['b']), ('finance', ['c'])])


class AnalysisCompatibilityTests(unittest.TestCase):
    setUp = SchedulerTests.setUp
    tearDown = SchedulerTests.tearDown
    create = SchedulerTests.create
    round = SchedulerTests.round
    clients = AnalysisSchedulerTests.clients
    next_analysis = AnalysisSchedulerTests.next_analysis

    def test_evicted_classification_changes_kind_and_world_analysis_replaces_finance(self):
        from back.scheduler import ClassifyResult, AnalysisResult
        from tests.test_classify import server
        from tests.test_analyze import world_answers
        value = {'kind': 'finance', 'market': 'positive', 'theme': 'memory', 'dir': 'bull', 'dir_p': 0.9}
        key = 'https://example.com/world-a'
        with server(lambda p, *_: (200, world_answers(len(p['state'])), {})) as (url, received):
            scheduler, sink, _ = self.create(lambda *_: analysis_feed(['world-a']), **self.clients(url))
            with scheduler.cv:
                scheduler._accept(ClassifyResult({key: 'finance'}))
                scheduler._accept(AnalysisResult({key: value}))
                scheduler._accept(ClassifyResult({f'other-{i}': 'politics' for i in range(4000)}))
                self.assertNotIn(key, scheduler.classify_cache)
                self.assertIn(key, scheduler.analysis_cache)
                scheduler._accept(ClassifyResult({key: 'world'}))
                packet = scheduler._decorate({'body': {'items': [{'link': key, 'source': '0',
                    'title': 'world-a', 'summary': '', 'published': '2026-09-25T00:00:00Z'}]}})
                self.assertIsNone(packet['body']['items'][0]['analysis'])
                self.assertEqual(packet['body']['analysis']['pending'], 1)
                self.assertNotIn(key, scheduler.analysis_cache)
                # Exercise the independent enqueue guard too, before _emit.
                scheduler.analysis_cache[key] = value
                from back.scheduler import ModelRound
                scheduler._enqueue_analysis(ModelRound(1), (key, 'world-a', ''))
                self.assertNotIn(key, scheduler.analysis_cache)
                self.assertEqual(scheduler.analysis_jobs.qsize(), 1)
            scheduler.start()
            first = self.round(sink)
            if first['analysis']['pending']:
                final = self.next_analysis(sink)
            else:
                final = first
            self.assertEqual(final['analysis']['pending'], 0)
            self.assertEqual(final['items'][0]['analysis']['kind'], 'world')
            self.assertEqual(len(received), 1)
            self.assertIn('trend_0', received[0][2]['questions'])

    def test_late_mismatched_results_never_replace_current_analysis(self):
        from back.scheduler import AnalysisResult
        from types import SimpleNamespace
        finance = {'kind': 'finance', 'market': 'positive', 'theme': 'memory', 'dir': 'bull', 'dir_p': 0.9}
        world = {'kind': 'world', 'trend': 'escalation', 'region': 'asia_pacific'}
        scheduler = Scheduler([{'name': 'A', 'url': 'unused'}], None, None, 1,
                              classifier=SimpleNamespace(enabled=True))
        for category, good, stale in [('world', world, finance), ('finance', finance, world), ('tech', finance, world)]:
            with self.subTest(category=category), scheduler.cv:
                scheduler.classify_cache['key'] = category
                scheduler.analysis_cache.clear()
                scheduler.analysis_in_flight.add('key')
                scheduler._accept(AnalysisResult({'key': stale}, ('key',), round_id=-1))
                self.assertNotIn('key', scheduler.analysis_cache)
                self.assertNotIn('key', scheduler.analysis_in_flight)
                scheduler._accept(AnalysisResult({'key': good}))
                scheduler._accept(AnalysisResult({'key': stale}, round_id=-1))
                self.assertEqual(scheduler.analysis_cache['key'], good)
