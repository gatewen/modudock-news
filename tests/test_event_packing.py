from itertools import combinations
from copy import deepcopy
from pathlib import Path
import json
import unittest

from back.events import Pair, candidate_pairs, group_events, pack_batch, _fits
from back.scheduler import Scheduler, ModelRound
from tests.test_events import record, disjoint
from tests import test_topic_admission as admission_tests
from tests.test_topics import snapshot, story


class EventPackingTests(unittest.TestCase):
    def test_complete_pair_set_limits_determinism_and_grouping(self):
        items = json.loads((Path(__file__).parent/'fixtures/events-300-2026-09-24.json').read_text())
        pairs = [p for p in candidate_pairs(items) if not p.automatic]
        remaining = list(pairs); batches = []
        while remaining:
            batch, remaining = pack_batch(remaining)
            self.assertTrue(_fits(batch))
            batches.append(batch)
        flattened = [p for batch in batches for p in batch]
        self.assertEqual(len(flattened),len(pairs))
        self.assertEqual({p.key for p in flattened},{p.key for p in pairs})
        self.assertEqual(pack_batch(pairs),pack_batch(deepcopy(pairs)))
        answers = {p.key: index % 3 == 0 for index,p in enumerate(pairs)}
        replay = {p.key:answers[p.key] for p in flattened}
        self.assertEqual(group_events(items,answers,[]),group_events(items,replay,[]))

    def test_question_state_and_character_caps(self):
        for records in ([record(i) for i in range(15)],
                        [record(i,'x'*300,'y'*200) for i in range(20)]):
            pairs=[Pair(a,b,.5) for a,b in combinations(records,2)]
            batch,rest=pack_batch(pairs)
            self.assertTrue(_fits(batch))
            self.assertEqual(len(batch),40)
            self.assertEqual(len(batch)+len(rest),len(pairs))
        batch,rest=pack_batch(disjoint(12))
        self.assertEqual(len(batch),10)
        self.assertEqual(len(rest),2)
        # Character cap can bind before either state or question count.
        pairs=[Pair(record(i*2,'x'*2000),record(i*2+1,'x'*2000),.5) for i in range(4)]
        batch,rest=pack_batch(pairs)
        self.assertEqual(len(batch),1)  # summaries also count, so two exceed 8000
        self.assertTrue(_fits(batch))

    def test_worker_packs_only_current_work_and_preserves_remaining(self):
        items,groups=snapshot();s=admission_tests.TopicAdmissionTests().make(items,groups)
        lane=next(l for l in s.lanes if l.name=='events')
        old,new=ModelRound(1),ModelRound(2)
        pairs=disjoint(13)
        for p in pairs[1:12]:s.event_jobs.put((old,p))
        s.event_jobs.put((new,pairs[12]))
        with s.cv:batch,_=s._take_batch(lane,old,pairs[0])
        self.assertEqual(len(batch),10)
        self.assertEqual(list(s.event_jobs.queue),[(old,p) for p in pairs[10:12]]+[(new,pairs[12])])

    def test_topics_admit_without_any_classification(self):
        items,groups=snapshot([story('candidate','ALPHA ALPHAX REACTION')])
        s=admission_tests.TopicAdmissionTests().make(items,groups)
        with s.cv:
            s.model_work=ModelRound(s.round_id)
            s.last_list=s._decorate(s.last_list)
            self.assertFalse(s.classify_cache)
            self.assertTrue(all(not i['category'] for i in s.last_list['body']['items']))
            s._enqueue_classification(s.last_list)
            self.assertFalse(s.classify_jobs.empty())
            # No matcher: automatic event edges already form a qualified seed.
            self.assertFalse(s.topic_jobs.empty())
            self.assertEqual(s._next_lane().name,'topics')
