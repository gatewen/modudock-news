from types import SimpleNamespace
import unittest

from back.scheduler import Scheduler, ModelRound
from back.events import Pair
from back.topics import TopicPair
from tests.test_classify import server
from tests.test_topics import snapshot, story, response
from tests.test_tone import tone_response
from tests import test_tone_scheduler as tone_helpers
from tests.test_scheduler import eventually


class ModelStatsTests(unittest.TestCase):
    setUp = tone_helpers.ToneSchedulerTests.setUp
    tearDown = tone_helpers.ToneSchedulerTests.tearDown
    make = tone_helpers.ToneSchedulerTests.make

    def test_snowball_round_logs_once_after_all_results_and_cache_only_round_is_silent(self):
        items, _ = snapshot([story('one', 'ALPHA BETA'), story('two', 'BETA DELTA')])
        def respond(payload, *_):
            return tone_response(payload) if 'q_0' in payload['questions'] else response(payload)
        with server(respond) as (url, received):
            s, _ = self.make(url, items)
            logs = []
            s.log = lambda line: logs.append(line) if line.startswith('model ') else None
            s.start()
            eventually(lambda: len(logs) == 1 and s.last_list['body']['topics']['tone_pending'] == 0, timeout=5)
            self.assertRegex(logs[0], r'^model round=1 requests=3 failed=0 elapsed=\d+\.\ds classify=0 analysis=0 events=0 topics=2 tone=1$')
            self.assertEqual(s.last_list['body']['topics']['tone_pending'], 0)
            s.refresh()
            eventually(lambda: s.completed == 2)
            with s.cv:
                s._finish_model_rounds()
            self.assertEqual(len(logs), 1)
            self.assertEqual(len(received), 3)

    def test_counts_failures_budget_and_exception_sanitization(self):
        for budget, failure in [(100, None), (80, None), (100, 'none'), (100, 'exception')]:
            with self.subTest(budget=budget, failure=failure):
                now, logs = [0], []
                def client(label, method):
                    def request(*args, **kwargs):
                        now[0] += 20
                        if label == 'analysis' and failure:
                            if failure == 'exception':
                                raise RuntimeError('SECRET https://private.invalid NEWS-CONTENT')
                            return None
                        return {}
                    return SimpleNamespace(enabled=True, **{method:request})
                classifier = client('classify', 'classify')
                classifier.clock = lambda: now[0]
                classifier.budget = budget
                s = Scheduler([{'name':'A','url':'unused'}], None, None, 1, classifier=classifier,
                              analyzer=client('analysis','analyze'), matcher=client('events','match'),
                              topic_matcher=client('topics','match'), tone_client=client('tone','tone'), log=logs.append)
                work = ModelRound(7)
                queues = [s.classify_jobs, s.analysis_jobs, s.event_jobs, s.topic_jobs, s.tone_jobs]
                s.classify_cache['a'] = 'finance'
                for jobs, item in zip(queues, [('c','NEWS-CONTENT',''), ('a','NEWS-CONTENT',''),
                    Pair(('l','l',''),('r','r',''),.5), TopicPair(('seed','s',''),('t','t','')), ('tone','SECRET','')]):
                    jobs.put((work,item))
                def submit(result):
                    with s.cv:
                        s._accept(result)
                        s._finish_model_rounds()
                        return any(not jobs.empty() for jobs in queues)
                s._submit_classification = submit
                s._classify_worker()
                stats = [line for line in logs if line.startswith('model ')]
                count = 2 if failure else 4 if budget == 80 else 5
                self.assertEqual(stats, [f'model round=7 requests={count} failed={int(bool(failure))} elapsed={count*20:.1f}s '
                    f'classify=1 analysis=1 events={int(not failure)} topics={int(not failure)} tone={int(not failure and budget==100)}'])
                self.assertFalse(s.model_rounds)
                self.assertFalse(any(secret in '\n'.join(logs) for secret in ['SECRET','private.invalid','NEWS-CONTENT']))
