"""Bound hostile feed text, destinations, and a single source's list share."""
from collections import Counter
import io
import socket
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from urllib.request import Request

from back.feedparse import plain, merge_items, MAX_ITEMS_SOURCE
from back.fetch import Fetcher, FetchError, _Redirect
from tests import test_parse


class SecurityLimitsTests(unittest.TestCase):
    def test_unfinished_html_is_bounded_before_parser_and_output_limit_still_applies(self):
        started = time.monotonic()
        self.assertLessEqual(len(plain('<a' * 30000, 300)), 300)
        self.assertLess(time.monotonic() - started, 1)
        # Observable input truncation, not just a machine-speed assertion.
        self.assertEqual(plain(' ' * 8192 + 'unreachable', 300), '')
        self.assertEqual(plain('x' * 8191 + '😀tail', 9000), 'x' * 8191 + '😀')
        self.assertEqual(plain('<b>A&amp;B</b>' * 100, 200), ('A&B' * 100)[:200])

    def test_encoded_or_non_whitelisted_hostname_never_reaches_dns_or_connection(self):
        resolver = Mock()
        fetcher = Fetcher(resolver=resolver, allow_hosts={'x%2f.attacker.example'})
        with patch('socket.getaddrinfo') as connected:
            for host in ['x%2F.attacker.example', 'x%00.example', 'under_score.example',
                         '中文.example', 'x\\evil.example', '[fe80::1%25eth0]']:
                with self.subTest(host=host):
                    result = fetcher.fetch('http://' + host + '/')
                    self.assertEqual(result.status, 'error')
                    self.assertIn('invalid hostname', result.error)
            resolver.assert_not_called()
            connected.assert_not_called()

    def test_ascii_hosts_and_ipv4_ipv6_literals_keep_address_checks(self):
        resolver = Mock(return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('8.8.8.8', 80))])
        f = Fetcher(resolver=resolver)
        for host in ['Example.COM', 'xn--fiqs8s.example', '8.8.8.8', '[2606:4700:4700::1111]']:
            f.check_destination('http://' + host + '/')
        self.assertEqual(resolver.call_count, 4)
        resolver.return_value = [(socket.AF_INET6, socket.SOCK_STREAM, 6, '', ('::1', 80))]
        with self.assertRaisesRegex(FetchError, 'private address'):
            f.check_destination('http://[::1]/')

    def test_all_redirect_codes_refuse_https_downgrade_before_following(self):
        for code in (301, 302, 303, 307, 308):
            for origin, target, allowed in [('https://example.com/a','http://example.com/b',False),
                ('https://example.com/a','/b',True), ('http://example.com/a','https://example.com/b',True)]:
                with self.subTest(code=code, origin=origin, target=target):
                    checked, parent = Mock(), Mock()
                    redirect = _Redirect(SimpleNamespace(check_destination=checked), lambda:None)
                    redirect.add_parent(parent)
                    request = Request(origin); request.timeout = 1
                    response = io.BytesIO()
                    call = lambda: getattr(redirect, f'http_error_{code}')(request,response,code,'',{'Location':target})
                    if allowed:
                        call(); checked.assert_called_once(); parent.open.assert_called_once()
                    else:
                        with self.assertRaisesRegex(FetchError,'downgrade'): call()
                        checked.assert_not_called(); parent.open.assert_not_called()
                    self.assertTrue(response.closed)

    def test_source_ceiling_preserves_floor_and_global_cap_without_mutating_inputs(self):
        item = test_parse.MergeAndSizeTests.item
        sources = [[item(self, str(i), f'https://e/{source}/{i}', f'2026-09-{25 if source < 5 else 1:02d}', str(source))
                    for i in range(100 if source < 5 else 4)] for source in range(6)]
        result = merge_items(sources)
        counts = Counter(i['source'] for i in result)
        self.assertEqual(len(result),300)
        self.assertEqual(MAX_ITEMS_SOURCE,60)
        self.assertTrue(all(3 <= count <= 60 for count in counts.values()),counts)
        self.assertEqual(counts['5'],3)
        self.assertEqual(len(merge_items([sources[0]])),60)
        self.assertEqual(len(sources[0]),100)
        self.assertEqual(result,merge_items([list(reversed(s)) for s in sources]))
