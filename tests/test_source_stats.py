"""Bounded, structured fetch-round diagnostics without remote text."""
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import URLError
from unittest.mock import patch
import threading
import unittest

from back.fetch import Fetcher
from back.scheduler import Scheduler, SOURCE_LOG_MAX
from tests.test_scheduler import Sink, FunctionFetcher, ok, eventually


@contextmanager
def source_server():
    mode = ['ok']
    release = threading.Event()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def do_GET(self):
            selected = self.path[1:] if self.path != '/sequence' else mode[0]
            if selected == 'timeout': release.wait(2)
            status = {'404':404, '503':503, '304':304}.get(selected, 200)
            body = b'<rss><channel/></rss>' if selected != 'parse' else b'<rss><PRIVATE'
            try:
                self.send_response(status)
                if selected == 'other': self.send_header('Content-Encoding', 'SECRET')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                if status != 304: self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError): pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=.01), daemon=True)
    thread.start()
    try: yield f'http://127.0.0.1:{server.server_port}', mode
    finally:
        release.set(); server.shutdown(); server.server_close(); thread.join(2)


class SourceStatsTests(unittest.TestCase):
    def setUp(self): self.schedulers = []
    def tearDown(self):
        for s in self.schedulers:
            s.stop()
            for thread in s.workers + [s.coordinator]:
                if thread.ident: thread.join(2)

    def make(self, feeds, fetcher, **kwargs):
        logs = []
        s = Scheduler(feeds, fetcher, Sink(), 1, log=logs.append, **kwargs)
        self.schedulers.append(s)
        return s, logs

    def summaries(self, logs): return [line for line in logs if line.startswith('sources round=')]

    def test_fake_server_failure_classes_and_one_summary_per_round(self):
        with source_server() as (url, _):
            feeds = [{'name':name, 'url':url+'/'+name} for name in ('ok','404','503','parse','other','timeout')]
            s, logs = self.make(feeds, Fetcher(allow_hosts={'127.0.0.1'}, timeout=.05))
            s.start(); eventually(lambda:s.completed == 1)
            self.assertEqual(self.summaries(logs), [
                'sources round=1 ok=1 not_modified=0 failed=5 timeout=1 http_4xx=1 http_5xx=1 parse=1 other=1 slow=0 streaks=404:1|503:1|parse:1|other:1|timeout:1'])
            self.assertNotIn('SECRET', '\n'.join(logs))
            self.assertNotIn('PRIVATE', '\n'.join(logs))
            self.assertNotIn(url, '\n'.join(logs))
            self.assertTrue(all('failure' not in source for source in s.last_list['body']['sources']))

    def test_success_fail_fail_304_resets_streak_without_remote_error_logging(self):
        with source_server() as (url, mode):
            s, logs = self.make([{'name':'自由時報即時','url':url+'/sequence'}], Fetcher(allow_hosts={'127.0.0.1'}))
            s.start(); eventually(lambda:s.completed == 1)
            for rid, value in enumerate(('503','503','304','404','ok'), 2):
                mode[0] = value; s.refresh(); eventually(lambda:s.completed == rid)
            lines = self.summaries(logs)
            self.assertEqual(len(lines),6)
            self.assertEqual([line.split('streaks=')[1] for line in lines],
                             ['-','自由時報即時:1','自由時報即時:2','-','自由時報即時:1','-'])
            self.assertIn('ok=0 not_modified=1 failed=0',lines[3])
            self.assertEqual(s.source_streaks,[0])

    def test_304_without_cache_is_other_failure(self):
        with source_server() as (url, _):
            s, logs = self.make([{'name':'A','url':url+'/304'}],Fetcher(allow_hosts={'127.0.0.1'}))
            s.start(); eventually(lambda:s.completed == 1)
            self.assertIn('ok=0 not_modified=0 failed=1',self.summaries(logs)[0])
            self.assertIn('other=1',self.summaries(logs)[0])

    def test_slow_threshold_and_coordinator_timeout_and_late_result(self):
        now=[0]; release=threading.Event(); entered=threading.Event()
        def fetch(*_):
            entered.set(); release.wait(2); return ok()
        s, logs=self.make([{'name':'A','url':'unused'}],FunctionFetcher(fetch),clock=lambda:now[0],source_timeout=11)
        s.start(); self.assertTrue(entered.wait(2))
        now[0]=11
        with s.cv: s.cv.notify_all()
        eventually(lambda:s.completed==1)
        release.set(); eventually(lambda:s.dropped_results==1)
        self.assertEqual(len(self.summaries(logs)),1)
        self.assertIn('timeout=1',self.summaries(logs)[0])
        self.assertIn('slow=1',self.summaries(logs)[0])
        self.assertEqual(s.source_streaks,[1])
        for duration, slow in ((10,0),(10.001,1)):
            s.source_outcomes=['ok'];s.source_elapsed=[duration]
            self.assertIn(f'slow={slow}',s._source_summary())

    def test_successful_fetch_elapsed_is_measured_with_injected_clock(self):
        now = [0]
        def fetch(*_):
            now[0] += 10.01
            return ok()
        s, logs = self.make([{'name':'A','url':'unused'}], FunctionFetcher(fetch), clock=lambda:now[0])
        s.start(); eventually(lambda:s.completed == 1)
        self.assertIn('ok=1 not_modified=0 failed=0', self.summaries(logs)[0])
        self.assertIn('slow=1', self.summaries(logs)[0])

    def test_log_bound_five_names_twenty_characters_and_no_control_sequences(self):
        feeds=[{'name':'來源'+str(i)+'😀'*30+'\nhttps://secret','url':'https://secret'} for i in range(32)]
        s, _=self.make(feeds,None)
        with s.cv: s._begin()
        s.source_outcomes=['other']*32
        line=s._source_summary()
        self.assertLessEqual(len(line.encode()),SOURCE_LOG_MAX)
        names=line.split('streaks=')[1].split('|')
        self.assertEqual(len(names),5)
        self.assertTrue(all(len(name.rsplit(':',1)[0])==20 for name in names))
        self.assertNotIn('\n',line);self.assertNotIn('https://',line)
        self.assertNotIn('來源5',line)

    def test_transport_timeout_code_handles_wrapped_socket_error(self):
        fetcher=Fetcher(allow_hosts={'127.0.0.1'})
        with patch.object(fetcher,'check_destination',side_effect=URLError(TimeoutError('SECRET'))):
            self.assertEqual(fetcher.fetch('http://127.0.0.1/').failure,'timeout')
