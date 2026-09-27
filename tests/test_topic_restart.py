"""Continuous (A->B) vs restart-at-B (warm) vs cold-at-B; deterministic content answers. No network."""
import hashlib, json, random, re, tempfile, unittest
from copy import deepcopy
from back import answer_cache as ac
from tests.test_model_chaos import Scenario, Response
from tests.test_scheduler import eventually

def h(*parts):
    return int(hashlib.sha256('|'.join(parts).encode()).hexdigest(), 16)

class Det(Scenario):
    def __init__(self, snaps, store):
        self._snaps = snaps
        super().__init__(1, 0)
        self.clean = True
        self.snapshots = snaps
        self.current = snaps[0]
        if store is not None:
            self.scheduler.answer_cache = ac.CacheBridge(store)
    def snapshot(self, version):
        return []
    def open(self, request, timeout):
        payload = json.loads(request.data)
        titles = {k: v['title'] for k, v in payload['state'].items()}
        with self.lock:
            self.outcomes['http'] += 1
        answers = {}
        for name, q in payload['questions'].items():
            crit = q['criteria']
            idx = re.findall(r'news_(\d+)', q['instructions'])
            ts = sorted(titles['news_' + i] for i in idx)
            if 'same' in crit:  # events
                c = 'same' if ts[0][:3] == ts[1][:3] else 'different'
            elif 'same_topic' in crit:
                c = 'same_topic' if h(*ts) % 3 else 'different'
            elif 'neutral' in crit and 'positive' in crit and 'mixed' in crit and len(crit) == 4:
                c = ['positive', 'negative', 'neutral', 'mixed'][h(ts[0], 'tone') % 4]
            elif 'world' in crit:
                c = 'world'
            else:
                c = 'other'
            answers[name] = {'choice': c, 'probabilities': {c: .95}}
        return Response(200, {'answers': answers})

def snaps(rng):
    outlets = ('甲', '乙', '丙')
    base = []
    n = 0
    topics = ['跨海和平峰會', '颱風豪雨災情', '晶片出口管制']
    for t in topics:
        for k in range(rng.randint(2, 5)):
            base.append((n, t + ''.join(rng.choice('合作協議進展反應消息談判續談') for _ in range(rng.randint(2, 5))), rng.choice(outlets))); n += 1
    for i in range(60):
        base.append((100 + i, ''.join(chr(0x5000 + i * 20 + j) for j in range(10)), outlets[i % 3]))
    a = list(base)
    b = [r for r in base if rng.random() > .2]
    for k in range(rng.randint(0, 4)):
        t = rng.choice(topics)
        b.append((200 + k, t + ''.join(rng.choice('合作協議進展反應消息') for _ in range(3)), rng.choice(outlets)))
    rng.shuffle(a); rng.shuffle(b)
    return [a, b]

class TopicRestartTests(unittest.TestCase):
    def test_seed_16_continuous_warm_and_cold_all_finish_without_waiting(self):
        snapshots = snaps(random.Random(16))
        with tempfile.TemporaryDirectory() as directory:
            store = ac.AnswerCache(directory, start_writer=False)
            for mode in ('continuous', 'warm', 'cold'):
                with self.subTest(mode=mode):
                    sc = Det(snapshots if mode == 'continuous' else [snapshots[1]],
                             store if mode == 'continuous' else
                             ac.AnswerCache(directory, start_writer=False) if mode == 'warm' else None)
                    s = sc.scheduler
                    try:
                        s.start()
                        for index in range(2 if mode == 'continuous' else 1):
                            if index:
                                with sc.lock:
                                    sc.current = snapshots[index]
                                s.refresh()
                            eventually(lambda: s.round_id == index + 1 and sc.settled()
                                       and s.last_list['body']['model']['state'] == 'done', timeout=5)
                            with s.cv:
                                self.assertEqual(s.last_list['body']['topics']['pending'], 0)
                                self.assertFalse(s.topic_in_flight)
                                self.assertTrue(s.topic_jobs.empty())
                        self.assertTrue(store.flush())
                    finally:
                        s.stop()
                        for thread in s.workers + [s.coordinator] + s.classify_workers:
                            thread.join(2)
                            self.assertFalse(thread.is_alive())
