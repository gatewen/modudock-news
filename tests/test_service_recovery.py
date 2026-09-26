"""Deterministic half-open and stale-response regressions (no live API)."""
from concurrent.futures import ThreadPoolExecutor
import threading
import unittest

from back.classify import Classifier, _service_round
from back.scheduler import Scheduler, ModelRound
from tests.test_classify import server, answers, items
from tests.test_scheduler import Sink, eventually


class ServiceRecoveryTests(unittest.TestCase):
    def test_logged_work_probe_blocks_peer_admission_and_recovers_same_round(self):
        entered, release = threading.Event(), threading.Event()
        def respond(payload, number, _):
            if number == 1:
                entered.set(); release.wait(3)
            return 200, answers(len(payload['state'])), {}
        with server(respond) as (url, received):
            client = Classifier(endpoint=url, key='test', clock=lambda:0, log=lambda _:None)
            client._state.service_failures = 3
            client._state.service_rounds = {1,2,3}
            s = Scheduler([{'name':'A','url':'unused'}],None,Sink(),1,classifier=client,log=lambda _:None)
            work = ModelRound(9, logged=True)
            for i in range(40): s.classify_jobs.put((work,(str(i),'title','')))
            s.classify_workers[0].start()
            try:
                self.assertTrue(entered.wait(2))
                with s.cv:
                    self.assertEqual(work.running,1)
                    self.assertEqual(s.model_running,1)
                    self.assertFalse(s.model_rounds)
                    self.assertIsNone(s._next_lane())
                for worker in s.classify_workers[1:]: worker.start()
                release.set()
                def finished():
                    with s.cv:
                        while s.results: s._accept(s.results.popleft())
                        s.cv.notify_all()
                        return len(s.classify_cache)==40 and not work.running
                eventually(finished)
                self.assertEqual(len(received),2)
                self.assertFalse(work.failed)
                self.assertFalse(client.service_circuit_open)
                self.assertEqual(work.awaiting,0)
                self.assertEqual(s.model_running,0)
                self.assertFalse(s.model_rounds)
            finally:
                release.set(); s.stop()
                for worker in s.classify_workers:
                    if worker.ident: worker.join(2)

    def test_repro_stale_success_excludes_older_round_failures(self):
        client = Classifier(endpoint='http://unused/',key='test',clock=lambda:0,log=lambda _:None)
        client._service_admit(1); client._service_admit(1)
        client._service_unavailable(1)
        client._service_admit(2); client._service_success()
        client._service_unavailable(1)
        self.assertEqual(client._state.service_failures,0)
        self.assertFalse(client._state.service_rounds)
        for rid in (3,4):
            client._service_admit(rid); client._service_unavailable(rid)
        self.assertFalse(client.service_circuit_open)
        client._service_admit(5); client._service_unavailable(5)
        self.assertTrue(client.service_circuit_open)

    def test_http_success_round_is_not_inferred_from_newer_admission(self):
        entered, release = threading.Event(), threading.Event()
        def respond(payload, number, _):
            if number == 1:
                entered.set(); release.wait(3)
                return 403, {}, {}
            return 200, answers(), {}
        with server(respond) as (url, _):
            client = Classifier(endpoint=url,key='test',log=lambda _:None)
            def request(rid):
                token = _service_round.set(rid)
                try: return client.classify(items())
                finally: _service_round.reset(token)
            with ThreadPoolExecutor(max_workers=2) as pool:
                old = pool.submit(request,1)
                try:
                    self.assertTrue(entered.wait(2))
                    # A newer admission must not move the successful-round
                    # watermark beyond the response that actually succeeded.
                    client._service_admit(10)
                    self.assertIsNotNone(request(2))
                finally: release.set()
                self.assertIsNone(old.result(2))
            self.assertEqual(client._state.service_failures,0)
            client._service_unavailable(3)
            self.assertEqual(client._state.service_failures,1)
