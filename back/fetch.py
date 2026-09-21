"""Single-source synchronous HTTP acquisition, without parsing or cache commits.

Deadlines are cooperative: DNS and slowly arriving headers can outlive them.
Destination validation does not pin DNS answers (no rebinding guarantee).
"""
from dataclasses import dataclass, field
import http.client
import ipaddress
import socket
import ssl
import os
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPHandler, HTTPSHandler, HTTPRedirectHandler, ProxyHandler, Request, build_opener

MAX_BODY = 2 * 1024 * 1024
USER_AGENT = "modudock-news/0.1 (+https://github.com/<owner>/modudock-news)"


@dataclass(frozen=True)
class Result:
    status: str
    data_bytes: bytes = b""
    final_url: str = ""
    validators: dict = field(default_factory=dict)
    error: str = ""


class FetchError(ValueError):
    pass


class _NoEncoding:
    def putrequest(self, method, url, skip_host=False, skip_accept_encoding=False):
        # http.client otherwise adds Accept-Encoding: identity automatically.
        return super().putrequest(method, url, skip_host=skip_host, skip_accept_encoding=True)


class _HTTPConnection(_NoEncoding, http.client.HTTPConnection):
    pass


class _HTTPSConnection(_NoEncoding, http.client.HTTPSConnection):
    pass


class _HTTP(HTTPHandler):
    def http_open(self, req):
        return self.do_open(_HTTPConnection, req)


class _HTTPS(HTTPSHandler):
    def https_open(self, req):
        return self.do_open(_HTTPSConnection, req, context=self._context)


class _Redirect(HTTPRedirectHandler):
    def __init__(self, fetcher, check_deadline):
        self.fetcher = fetcher
        self.check_deadline = check_deadline
        self.count = 0

    def http_error_302(self, req, response, code, msg, headers):
        # Do not drain an untrusted redirect body (stdlib's default does).
        response.close()
        self.check_deadline()
        if "Content-Encoding" in headers:
            raise FetchError("Content-Encoding forbidden")
        location = headers.get("Location")
        if location is None:
            raise FetchError("redirect without Location")
        self.count += 1
        if self.count > 5:
            raise FetchError("redirect limit")
        target = urljoin(req.full_url, location)
        self.fetcher.check_destination(target)
        self.check_deadline()
        new = Request(target, headers=dict(req.headers))
        return self.parent.open(new, timeout=req.timeout)

    http_error_301 = http_error_303 = http_error_307 = http_error_308 = http_error_302


class Fetcher:
    def __init__(self, allow_hosts=frozenset(), resolver=socket.getaddrinfo,
                 timeout=15, deadline=30, clock=time.monotonic, ssl_context=None, ca_file=None):
        if timeout <= 0 or deadline <= 0:
            raise ValueError("timeouts must be positive")
        self.allow_hosts = frozenset(allow_hosts)
        self.resolver = resolver
        self.timeout, self.deadline, self.clock = timeout, deadline, clock
        self.ssl_context = ssl_context if ssl_context is not None else ssl.create_default_context()
        # Enforce verification even on an injected context. Configure once,
        # before the shared Fetcher is handed to worker threads.
        self.ssl_context.verify_mode = ssl.CERT_REQUIRED
        # check_hostname=True can itself upgrade CERT_NONE in CPython. Check
        # this invariant first so that implicit upgrade cannot hide a broken
        # certificate-verification configuration step.
        if self.ssl_context.verify_mode != ssl.CERT_REQUIRED:
            raise ValueError("TLS requires certificate verification")
        self.ssl_context.check_hostname = True
        paths = [ca_file] if ca_file is not None else [
            os.environ.get("SSL_CERT_FILE"), "/etc/ssl/cert.pem",
            "/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt"]
        for path in paths:
            if self.ssl_context.cert_store_stats()["x509_ca"]:
                break
            if path:
                try:
                    self.ssl_context.load_verify_locations(cafile=path)
                except (OSError, ssl.SSLError):
                    pass
        self.has_ca = self.ssl_context.cert_store_stats()["x509_ca"] > 0

    def check_destination(self, url):
        if not isinstance(url, str) or any(ord(c) <= 32 or ord(c) == 127 for c in url):
            raise FetchError("invalid URL")
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise FetchError("scheme must be http/https with a host")
        if parts.username is not None or parts.password is not None:
            raise FetchError("userinfo forbidden")
        if parts.scheme == "https" and not self.has_ca:
            raise FetchError("no CA certificates")
        port = parts.port or (443 if parts.scheme == "https" else 80)
        host = parts.hostname
        addresses = self.resolver(host, port, type=socket.SOCK_STREAM)
        if not addresses:
            raise FetchError("DNS returned no addresses")
        for _family, _type, _proto, _canon, address in addresses:
            ip = ipaddress.ip_address(address[0])
            ip = ip.ipv4_mapped if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped else ip
            if host not in self.allow_hosts and (
                not ip.is_global or ip.is_multicast or ip.is_reserved or ip.is_unspecified
            ):
                raise FetchError("private address")

    def fetch(self, url, validators=None):
        started = self.clock()

        def check_deadline():
            if self.clock() - started >= self.deadline:
                raise FetchError("deadline")

        try:
            self.check_destination(url)
            check_deadline()
            headers = {"User-Agent": USER_AGENT}
            for key, header in (("etag", "If-None-Match"), ("last_modified", "If-Modified-Since")):
                value = (validators or {}).get(key)
                if value:
                    if not isinstance(value, str) or "\r" in value or "\n" in value:
                        raise FetchError("invalid validator")
                    headers[header] = value
            opener = build_opener(ProxyHandler({}), _HTTP(), _HTTPS(context=self.ssl_context), _Redirect(self, check_deadline))
            try:
                response = opener.open(Request(url, headers=headers), timeout=self.timeout)
            except HTTPError as exc:
                response = exc
            with response:
                check_deadline()
                if "Content-Encoding" in response.headers:
                    raise FetchError("Content-Encoding forbidden")
                if response.code == 304:
                    return Result("not_modified")
                if not 200 <= response.code < 300:
                    raise FetchError(f"HTTP {response.code}")
                data = bytearray()
                while True:
                    check_deadline()
                    block = response.read1(min(65536, MAX_BODY + 1 - len(data)))
                    check_deadline()
                    if not block:
                        if response.length not in (None, 0):
                            raise FetchError("truncated body")
                        break
                    data.extend(block)
                    if len(data) > MAX_BODY:
                        raise FetchError("body exceeds 2 MiB")
                return Result("ok", bytes(data), response.geturl(), {
                    "etag": response.headers.get("ETag"),
                    "last_modified": response.headers.get("Last-Modified"),
                })
        except (FetchError, OSError, URLError, ValueError, http.client.HTTPException) as exc:
            reason = "deadline" if self.clock() - started >= self.deadline else str(exc)
            return Result("error", error=reason[:200])
