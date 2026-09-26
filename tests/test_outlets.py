"""Publisher identity is distinct from feed name and feed ordering."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

from back.news import preflight
from back.scheduler import Scheduler, Cache
from back.topics import plan
from tests.test_topics import story, snapshot


class OutletTests(unittest.TestCase):
    def test_optional_outlet_validation_and_default_names(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'feeds.json'
            for outlet in (None,{},[],False,7,'',' ',' x','x ','x'*65):
                path.write_text(json.dumps([{'name':'feed','url':'https://example.com/rss','outlet':outlet}]))
                self.assertIsNotNone(preflight(path)[1],outlet)
            for extra in ({},{'outlet':'中央社'}):
                path.write_text(json.dumps([{'name':'feed','url':'https://example.com/rss',**extra}]))
                self.assertIsNone(preflight(path)[1])
        feeds,error=preflight(Path(__file__).parents[1]/'back/feeds.json')
        self.assertIsNone(error)
        for feed in feeds:
            if feed['name'].startswith('中央社'): self.assertEqual(feed['outlet'],'中央社')
            if feed['name'].startswith('經濟日報'): self.assertEqual(feed['outlet'],'經濟日報')

    def test_seed_threshold_and_previous_topic_final_threshold_use_outlets(self):
        feeds=['中央社 政治','中央社 財經','中央社 國際','公視','BBC']
        outlets={name:('中央社' if name.startswith('中央社') else name) for name in feeds}
        seeds=[story(f's{i}','峰會 ALPHA',name) for i,name in enumerate(feeds[:3])]
        items,groups=snapshot(seeds=seeds)
        self.assertEqual(plan(items,groups,{},feeds,outlets=outlets),([],[]))
        self.assertEqual(plan(items,groups,{},feeds,[seeds[0]['link']],outlets=outlets),([],[]))
        for name in feeds[3:]:
            item=story(f's{len(seeds)}','峰會 ALPHA',name)
            seeds.append(item)
        items,groups=snapshot(seeds=seeds)
        topics,_=plan(items,groups,{},feeds,outlets=outlets)
        self.assertEqual([(t['sources'],t['count']) for t in topics],[(3,5)])
        self.assertEqual(topics[0]['keys'],[item['link'] for item in seeds])
        # Missing outlet metadata retains the original per-name behavior.
        topics,_=plan(items,groups,{},feeds)
        self.assertEqual(topics[0]['sources'],5)

    def test_scheduler_sources_topic_counts_and_pending_recount_use_same_identity(self):
        names=['中央社 政治','中央社 財經','中央社 國際','公視','BBC']
        feeds=[{'name':name,'url':f'https://example.com/{i}',
                **({'outlet':'中央社'} if i<3 else {})} for i,name in enumerate(names)]
        items=[story(str(i),'共同新聞事件完整標題',name) for i,name in enumerate(names)]
        outbox=Mock(); outbox.put.return_value=True
        s=Scheduler(feeds,Mock(),outbox,1)
        s.caches=[Cache([item],available=True) for item in items]
        with s.cv: s._begin()
        first=s._emit(s.caches,deepcopy(s.status))
        self.assertEqual([v['outlet'] for v in first['body']['sources']],['中央社']*3+['公視','BBC'])
        self.assertEqual(first['body']['topics']['list'][0]['sources'],3)
        self.assertEqual(first['body']['topics']['list'][0]['count'],5)
        pending=deepcopy(first)
        pending['body']['events']['pending']=1
        pending['body']['items']=pending['body']['items'][:-1]
        with s.cv: result=s._decorate_topics(pending,{})
        self.assertEqual(result['body']['topics']['list'],[])  # Four feeds, only two publishers.
        self.assertTrue(all('topic' not in item for item in result['body']['items']))
        only_cna=s._emit(s.caches[:3],deepcopy(s.status))
        self.assertEqual(only_cna['body']['topics']['list'],[])
        s.stop()
