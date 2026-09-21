from pathlib import Path
import ssl
import tempfile
import unittest
from unittest.mock import Mock, patch

from back.fetch import Fetcher


class TLSTests(unittest.TestCase):
    def empty(self):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        self.assertEqual(context.cert_store_stats()["x509_ca"], 0)
        return context

    def bundle(self):
        for path in ("/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt"):
            if Path(path).is_file():
                return path
        self.fail("TLS fallback test requires a system CA bundle")

    def test_empty_context_loads_injected_fallback(self):
        context = self.empty()
        fetcher = Fetcher(ssl_context=context, ca_file=self.bundle())
        self.assertIs(fetcher.ssl_context, context)
        self.assertTrue(fetcher.has_ca)
        self.assertGreater(context.cert_store_stats()["x509_ca"], 0)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)

    def test_injected_insecure_context_is_hardened(self):
        context = self.empty()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        Fetcher(ssl_context=context, ca_file=self.bundle())
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)

    def test_no_ca_fails_before_dns_or_connection(self):
        with tempfile.TemporaryDirectory() as directory:
            resolver = Mock(side_effect=AssertionError("DNS must not run"))
            fetcher = Fetcher(ssl_context=self.empty(), ca_file=str(Path(directory) / "missing.pem"), resolver=resolver)
            with patch("socket.create_connection") as connect:
                result = fetcher.fetch("https://example.com/")
            self.assertEqual(result.status, "error")
            self.assertEqual(result.error, "no CA certificates")
            resolver.assert_not_called()
            connect.assert_not_called()
            self.assertEqual(fetcher.ssl_context.verify_mode, ssl.CERT_REQUIRED)
            self.assertTrue(fetcher.ssl_context.check_hostname)

    def test_environment_bundle_first_and_context_created_once(self):
        context = self.empty()
        with patch.dict("os.environ", {"SSL_CERT_FILE": self.bundle()}), \
             patch("back.fetch.ssl.create_default_context", return_value=context) as factory:
            fetcher = Fetcher()
            self.assertTrue(fetcher.has_ca)
            fetcher.fetch("file:///rejected")
            fetcher.fetch("file:///rejected")
            factory.assert_called_once_with()
