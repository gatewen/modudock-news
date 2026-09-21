from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
import io
import socket
import threading
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace

from back.fetch import Fetcher, FetchError, MAX_BODY, USER_AGENT


@contextmanager
def server():
    received = []
    header_started = threading.Event()
    release_headers = threading.Event()
    stop = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            received.append((self.path, dict(self.headers)))
            try:
                if self.path == "/headers":
                    self.wfile.write(b"HTTP/1.1 200 OK\r\nX-Slow: ")
                    self.wfile.flush()
                    header_started.set()
                    while not release_headers.wait(0.02) and not stop.is_set():
                        self.wfile.write(b"x")
                        self.wfile.flush()
                    self.wfile.write(b"\r\nContent-Length: 0\r\n\r\n")
                    self.wfile.flush()
                    return
                if self.path == "/drip":
                    self.send_response(200)
                    self.send_header("Content-Length", "1000")
                    self.end_headers()
                    for _ in range(1000):
                        self.wfile.write(b"x")
                        self.wfile.flush()
                        if stop.wait(0.02):
                            break
                    return
                redirects = {"/private": "http://10.255.255.1/", "/file": "file:///etc/passwd", "/redirect": "/ok"}
                if self.path.startswith("/chain/"):
                    count = int(self.path.rsplit("/", 1)[1])
                    if count:
                        redirects[self.path] = f"/chain/{count - 1}"
                if self.path in redirects:
                    self.send_response(302)
                    self.send_header("Location", redirects[self.path])
                    self.end_headers()
                    return
                code = 304 if self.path == "/304" else 503 if self.path == "/503" else 200
                body = b"<rss/>" if self.path != "/large" else b"x" * (MAX_BODY + 1)
                if self.path == "/exact":
                    body = b"x" * MAX_BODY
                self.send_response(code)
                self.send_header("ETag", '"version1"')
                self.send_header("Last-Modified", "Mon, 21 Sep 2026 00:00:00 GMT")
                if self.path == "/gzip":
                    self.send_header("Content-Encoding", "gzip")
                self.send_header("Content-Length", str(len(body) + (10 if self.path == "/truncated" else 0)))
                self.end_headers()
                if code != 304:
                    self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=lambda: httpd.serve_forever(poll_interval=0.02), daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_port}", received, header_started, release_headers
    finally:
        stop.set()
        release_headers.set()
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2)


class FetchTests(unittest.TestCase):
    def fetcher(self, **kwargs):
        return Fetcher(allow_hosts={"127.0.0.1"}, **kwargs)

    def test_normal_headers_validators_and_no_proxy(self):
        with server() as (base, received, *_):
            validators = {"etag": '"old"', "last_modified": "yesterday"}
            with patch.dict(os.environ, {"http_proxy": "http://127.0.0.1:1", "HTTP_PROXY": "http://127.0.0.1:1", "no_proxy": ""}):
                result = self.fetcher().fetch(base + "/ok", validators)
            self.assertEqual(result.status, "ok")
            self.assertEqual(result.data_bytes, b"<rss/>")
            self.assertEqual(result.final_url, base + "/ok")
            self.assertEqual(result.validators["etag"], '"version1"')
            self.assertEqual(validators["etag"], '"old"')
            headers = {k.lower(): v for k, v in received[0][1].items()}
            self.assertNotIn("accept-encoding", headers)
            self.assertEqual(headers["user-agent"], USER_AGENT)
            self.assertEqual(headers["if-none-match"], '"old"')
            self.assertEqual(headers["if-modified-since"], "yesterday")

    def test_304_and_503_and_encoding(self):
        with server() as (base, *_):
            self.assertEqual(self.fetcher().fetch(base + "/304").status, "not_modified")
            for path, reason in (("/503", "HTTP 503"), ("/gzip", "Content-Encoding")):
                result = self.fetcher().fetch(base + path)
                self.assertEqual(result.status, "error")
                self.assertIn(reason, result.error)
                self.assertEqual(result.data_bytes, b"")

    def test_body_size_boundary(self):
        with server() as (base, *_):
            exact = self.fetcher().fetch(base + "/exact")
            self.assertEqual(exact.status, "ok")
            self.assertEqual(len(exact.data_bytes), MAX_BODY)
            large = self.fetcher().fetch(base + "/large")
            self.assertEqual(large.status, "error")
            self.assertIn("2 MiB", large.error)
            self.assertEqual(large.data_bytes, b"")

    def test_truncated_body_not_success(self):
        with server() as (base, *_):
            result = self.fetcher().fetch(base + "/truncated")
            self.assertEqual(result.error, "truncated body")
            self.assertEqual(result.data_bytes, b"")

    def test_cli_allow_host_only_configures_fetcher(self):
        from back import news
        with patch.object(news, "Fetcher") as constructor, \
             patch.object(news.sys, "stdin", SimpleNamespace(buffer=io.BytesIO())), \
             patch.object(news.sys, "stdout", SimpleNamespace(buffer=io.BytesIO())):
            self.assertEqual(news.main(["--allow-host", "127.0.0.1", "--allow-host", "localhost"]), 0)
            constructor.assert_called_once_with(allow_hosts=["127.0.0.1", "localhost"])
            constructor.return_value.fetch.assert_not_called()

    def test_redirect_final_url_and_five_vs_six(self):
        with server() as (base, received, *_):
            result = self.fetcher().fetch(base + "/redirect")
            self.assertEqual(result.status, "ok")
            self.assertEqual(result.final_url, base + "/ok")
            self.assertEqual(self.fetcher().fetch(base + "/chain/5").status, "ok")
            received.clear()
            result = self.fetcher().fetch(base + "/chain/6")
            self.assertEqual(result.error, "redirect limit")
            self.assertEqual([path for path, _ in received], [f"/chain/{i}" for i in range(6, 0, -1)])

    def test_redirect_file_rejected(self):
        with server() as (base, received, *_):
            result = self.fetcher().fetch(base + "/file")
            self.assertEqual(result.status, "error")
            self.assertIn("scheme", result.error)
            self.assertEqual(len(received), 1)

    def test_redirect_private_rejected_before_connect(self):
        with server() as (base, received, *_):
            started = time.monotonic()
            result = self.fetcher(timeout=0.2).fetch(base + "/private")
            self.assertLess(time.monotonic() - started, 1)
            self.assertEqual([path for path, _ in received], ["/private"])
            self.assertEqual(result.status, "error")
            self.assertEqual(result.error, "private address")

    def test_drip_body_cooperative_deadline(self):
        # 20 ms/byte models the 1 second/byte source with a scaled deadline.
        with server() as (base, received, *_):
            started = time.monotonic()
            result = self.fetcher(timeout=0.2, deadline=0.15).fetch(base + "/drip")
            elapsed = time.monotonic() - started
            self.assertEqual(len(received), 1)
            self.assertEqual(result.error, "deadline")
            self.assertGreaterEqual(elapsed, 0.15)
            self.assertLess(elapsed, 0.6)

    def test_known_limit_slow_headers_outlive_deadline(self):
        with server() as (base, received, started, release):
            result = []
            finished = threading.Event()
            def run():
                result.append(self.fetcher(timeout=0.3, deadline=0.1).fetch(base + "/headers"))
                finished.set()
            worker = threading.Thread(target=run, daemon=True)
            worker.start()
            try:
                self.assertTrue(started.wait(1))
                self.assertEqual(received[0][0], "/headers")
                self.assertFalse(finished.wait(0.25), "known limitation unexpectedly changed")
                self.assertTrue(worker.is_alive())
            finally:
                release.set()
                worker.join(timeout=2)
            self.assertFalse(worker.is_alive())
            self.assertEqual(result[0].error, "deadline")


class DestinationTests(unittest.TestCase):
    def resolver(self, *ips):
        return lambda *_args, **_kwargs: [(socket.AF_INET6 if ":" in ip else socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 80)) for ip in ips]

    def test_all_addresses_checked_and_mapped_private_rejected(self):
        for ip in ("127.0.0.1", "10.1.1.1", "172.16.1.1", "192.168.1.1", "169.254.1.1", "224.0.0.1", "240.0.0.1", "0.0.0.0", "::1", "fe80::1", "fc00::1", "ff02::1", "::", "::ffff:10.1.1.1"):
            with self.subTest(ip=ip), self.assertRaisesRegex(FetchError, "private address"):
                Fetcher(resolver=self.resolver("8.8.8.8", ip)).check_destination("https://example.com/")
        Fetcher(resolver=self.resolver("8.8.8.8", "2606:4700:4700::1111")).check_destination("https://example.com/")

    def test_allow_host_exact_not_suffix_or_resolved_ip(self):
        fetcher = Fetcher(allow_hosts={"allowed.test", "127.0.0.1"}, resolver=self.resolver("127.0.0.1"))
        fetcher.check_destination("http://allowed.test/")
        fetcher.check_destination("http://127.0.0.1/")
        for host in ("sub.allowed.test", "allowed.test.evil", "other.test"):
            with self.assertRaisesRegex(FetchError, "private address"):
                fetcher.check_destination("http://" + host)

    def test_invalid_scheme_userinfo_and_empty_dns(self):
        with server() as (base, received, *_):
            fetcher = Fetcher(allow_hosts={"127.0.0.1"})
            cases = ((base.replace("http://", "http://u:p@"), "userinfo forbidden"),
                     ("file:///x", "scheme must be http/https with a host"),
                     ("http://127.0.0.1:bad/", "Port could not be cast to integer value as 'bad'"),
                     (base + "/\n", "invalid URL"))
            for url, reason in cases:
                with self.subTest(url=url):
                    result = fetcher.fetch(url)
                    self.assertEqual(result.status, "error")
                    self.assertEqual(result.error, reason)
                    self.assertEqual(received, [])
        self.assertEqual(Fetcher(resolver=self.resolver()).fetch("http://example.com").status, "error")

    def test_errors_bounded_and_validator_injection_rejected(self):
        def broken(*args, **kwargs):
            raise OSError("x" * 1000)
        result = Fetcher(resolver=broken).fetch("http://example.com")
        self.assertEqual(len(result.error), 200)
        with server() as (base, received, *_):
            result = Fetcher(allow_hosts={"127.0.0.1"}).fetch(base, {"etag": "a\r\nBad: x"})
            self.assertEqual(result.status, "error")
            self.assertEqual(received, [])
