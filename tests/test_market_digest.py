"""Strict broadcast contract, scheduler timing and actual JS panel parity; no API."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
import math
from pathlib import Path
import re
import unicodedata
import shutil
import subprocess
import unittest
from unittest.mock import patch

from back.market_digest import build_digest, compact, fit_digest, THEME_NAMES, TOPIC
from back.news import Outbox
from back.scheduler import Scheduler, Cache, ModelRound, AnalysisResult
from back.classify import Classifier
from back.analyze import Analyzer
from back.fetch import Result
from tests.test_scheduler import Sink, FunctionFetcher, eventually

NOW = datetime(2026, 9, 28, 13, 20, 30, 123456, tzinfo=timezone(timedelta(hours=8)))
FEEDS = [dict(name='中央社 財經', outlet='中央社', url='unused'),
         dict(name='中央社 政治', outlet='中央社', url='unused'),
         dict(name='公視', url='unused')]


def analysis(market='positive', theme='memory', direction='bull', p=.9):
    return dict(kind='finance', market=market, theme=theme, dir=direction, dir_p=p)


def item(n, *, hours=1, source='中央社 財經', event=None, category='finance', value=None):
    return dict(link=f'https://example.test/{n}', title=f'標題{n}', summary='摘要', source=source,
                published=(NOW-timedelta(hours=hours)).isoformat(), category=category,
                event=event or f'{n:012x}', event_size=1, analysis=value if value is not None else analysis())


def fixture():
    a = item(1, hours=26, value=None)
    a['analysis'] = None
    return [a, item(2, event=a['event'], source='中央社 政治', value=analysis('negative', 'energy', 'bear')),
            item(3, event=a['event'], hours=.5, source='公視', value=analysis('positive')),
            item(4, value=analysis('mixed', 'memory', 'bull', .6)),
            item(5, value=analysis('other', 'memory', 'bear', .59)),
            item(6, value=analysis('not_market', 'memory', 'bear', .6)),
            item(7, value=analysis('positive', 'macro', 'bull')),
            item(8, value=analysis('negative', 'other', 'bear')),
            item(9, category='tech'), item(10, hours=25), item(11, hours=-.1)]


class DigestTests(unittest.TestCase):
    def assert_contract(self, body):
        self.assertEqual(set(body), {'schema','at','window_hours','signal_counts','top_themes','source_count'})
        self.assertIs(type(body['schema']), int)
        self.assertEqual(body['schema'], 1)
        self.assertEqual(body['window_hours'], 24)
        self.assertIs(type(body['window_hours']), int)
        self.assertRegex(body['at'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?[+-]\d\d:\d\d$')
        self.assertEqual(datetime.fromisoformat(body['at']), NOW)
        directions = {'bullish','mixed','unrelated','bearish'}
        self.assertEqual(set(body['signal_counts']), directions)
        for count in [*body['signal_counts'].values(), body['source_count']]:
            self.assertIs(type(count), int)
            self.assertTrue(0 <= count <= 1000000)
        self.assertLessEqual(len(body['top_themes']), 10)
        names = []
        for row in body['top_themes']:
            self.assertEqual(set(row), {'name','events','direction'})
            self.assertIs(type(row['events']), int)
            self.assertTrue(1 <= row['events'] <= 1000000)
            self.assertIn(row['direction'], directions)
            self.assertIs(type(row['name']), str)
            self.assertTrue(1 <= len(row['name']) <= 80)
            self.assertEqual(row['name'].strip(), row['name'])
            self.assertNotRegex(row['name'], r'[\x00-\x1f\x7f]|://|www\.|\]\(')
            names.append(row['name'])
        self.assertEqual(len(names), len(set(names)))
        wire = Outbox.encode(dict(t='publish', seq=3, topic=TOPIC, body=body))
        self.assertIn(compact(body), wire)
        self.assertLessEqual(len(compact(body)), 8192)
        def unique(pairs):
            self.assertEqual(len(pairs), len(dict(pairs)))
            return dict(pairs)
        parsed = json.loads(wire, object_pairs_hook=unique,
                            parse_constant=lambda _: self.fail('non-finite JSON'))
        self.assertEqual(parsed['body'], body)
        self.assertNotIn('https:', wire.decode())
        self.assertNotIn('title', wire.decode())
        self.assertNotIn('summary', wire.decode())

    def test_manifest_declares_both_broadcasts_and_fixed_labels_are_safe(self):
        manifest=json.loads((Path(__file__).resolve().parents[1]/'modudock.json').read_text())
        self.assertEqual(manifest['provides'], ['news.fetched', TOPIC])
        for name in THEME_NAMES.values():
            self.assertTrue(1 <= len(name) <= 80)
            self.assertEqual(name, name.strip())
            self.assertFalse(any(unicodedata.category(c).startswith('C') for c in name))
            self.assertNotRegex(name, r'://|www\.|\]\(|[\w-]+\.[a-zA-Z]{2,}(?:\b|/)')

    def test_contract_window_outlets_representative_and_directions(self):
        items = fixture(); before = deepcopy(items)
        body = build_digest(items, FEEDS, NOW)
        self.assert_contract(body)
        self.assertEqual(items, before)
        self.assertEqual(body['signal_counts'], dict(bullish=1, mixed=1, unrelated=2, bearish=2))
        self.assertEqual(body['source_count'], 2)
        self.assertEqual(body['top_themes'], [dict(name='記憶體',events=3,direction='mixed'),
                                               dict(name='能源',events=1,direction='bearish')])

    def test_window_boundaries_future_and_missing_analysis(self):
        rows = [item(1, hours=24), item(2,hours=0), item(3,hours=24.000001), item(4,hours=-.000001)]
        self.assertEqual(build_digest(rows, FEEDS, NOW)['signal_counts']['bullish'], 2)
        for bad in (None, {}, True, analysis(p=True), analysis(p=math.nan), analysis(p=math.inf),
                    analysis(theme='unknown'), dict(kind='world',trend='other',region='other')):
            with self.subTest(bad=bad):
                rows=[item(1)]; rows[0]['analysis']=bad
                self.assertIsNone(build_digest(rows, FEEDS, NOW))
        self.assertIsNone(build_digest([item(1,category='tech')], FEEDS, NOW))
        with self.assertRaises(ValueError):
            build_digest([], FEEDS, NOW.replace(tzinfo=None))

    def test_all_direction_combinations_ties_top_ten_and_maximum_packet(self):
        names=[k for k in THEME_NAMES if k not in ('macro','other')]
        rows=[item(i+1,value=analysis(theme=theme,direction='mixed')) for i,theme in enumerate(names)]
        body=build_digest(rows,FEEDS,NOW)
        self.assertEqual([r['name'] for r in body['top_themes']], [THEME_NAMES[k] for k in names[:10]])
        self.assertTrue(all(r['direction']=='unrelated' for r in body['top_themes']))
        self.assert_contract(body)
        # Maximum admitted items, full source names, every optional input field.
        rows=[item(i+1,source='源'*64,value=analysis(theme=names[i%len(names)])) for i in range(550)]
        body=build_digest(rows,FEEDS,NOW)
        self.assert_contract(body)
        self.assertEqual(sum(body['signal_counts'].values()),550)
        # Exercise the guard with a smaller budget, preserving original order
        # and counts. Production fixed labels already fit well below 8192.
        cap=len(compact({**body,'top_themes':body['top_themes'][:3]}))
        fitted=fit_digest(body,cap)
        self.assertEqual(fitted['top_themes'],body['top_themes'][:3])
        self.assertEqual(fitted['signal_counts'],body['signal_counts'])
        self.assertIsNone(fit_digest(body,1))
        self.assertEqual(len(body['top_themes']),10)

    @unittest.skipUnless(shutil.which('node'), 'Node needed for real frontend parity')
    def test_same_fixture_matches_actual_frontend_panel_and_label_table(self):
        script = '''import {groupItems} from './front/scope.js';
import {aggregatePanel} from './front/panel.js';
import {themeNames} from './front/labels.js';
let s='';for await (const c of process.stdin) s+=c;
const {items,feeds,now}=JSON.parse(s), at=Date.parse(now);
const groups=groupItems(items.filter(i=>i.category==='finance'), new Map(feeds.map((f,i)=>[f.name,i])))
 .filter(g=>{const latest=Math.max(...g.reports.map(i=>Date.parse(i.published)));return latest>=at-86400000&&latest<=at});
const p=aggregatePanel(groups,'finance');
console.log(JSON.stringify({labels:[...themeNames],values:p.values,
 themes:p.ranked.map(([id,c])=>({name:themeNames.get(id),events:c.count,
 direction:c.bull&&c.bear?'mixed':c.bull?'bullish':c.bear?'bearish':'unrelated'}))}));'''
        submillis=[item(1,source='公視',value=analysis('negative','energy','bear')),item(2,event=f'{1:012x}')]
        for row, micro in zip(submillis,(100,900)):
            row['published']=(NOW-timedelta(hours=1)).replace(microsecond=micro).isoformat()
        for rows in (fixture(), submillis):
            out=subprocess.run(['node','--input-type=module','-e',script],cwd=Path(__file__).resolve().parents[1],
                input=json.dumps(dict(items=rows,feeds=FEEDS,now=NOW.isoformat())),text=True,capture_output=True,check=True)
            front=json.loads(out.stdout); body=build_digest(rows,FEEDS,NOW)
            self.assertEqual(front['labels'],[list(x) for x in THEME_NAMES.items()])
            self.assertEqual(front['values'],list(body['signal_counts'].values()))
            self.assertEqual(front['themes'],body['top_themes'])


class DigestSchedulingTests(unittest.TestCase):
    def make(self):
        self.sink=Sink()
        client=Classifier(key='fake-digest-test',log=lambda _:None)
        s=Scheduler(FEEDS,FunctionFetcher(lambda *_:Result('not_modified')),self.sink,99,
                    classifier=client,analyzer=Analyzer(shared=client),now=lambda:NOW,log=lambda _:None)
        self.addCleanup(s.stop)
        rows=[item(1)]
        s.round_id=1; s.model_work=ModelRound(1)
        s.last_list={'t':'msg','seq':99,'body':dict(op='list',items=rows,sources=[],at=(NOW-timedelta(minutes=5)).isoformat(),
            classify=dict(enabled=True,pending=0),analysis=dict(pending=0),events=dict(pending=0))}
        return s

    def packets(self):
        return list(self.sink.packets.queue)

    def test_once_per_round_at_publication_time_and_new_round_allowed(self):
        s=self.make()
        for _ in range(3):s._publish_market_digest()
        self.assertEqual(len(self.packets()),1)
        p=self.packets()[0]
        self.assertEqual((p['t'],p['seq'],p['topic']),('publish',99,TOPIC))
        self.assertEqual(datetime.fromisoformat(p['body']['at']),NOW)
        s.round_id=2;s.model_work=ModelRound(2)
        s._publish_market_digest()
        self.assertEqual(len(self.packets()),2)

    def test_pending_failure_disabled_empty_and_superseded_do_not_publish(self):
        s=self.make()
        for lane in ('classify','analysis','events'):
            s.last_list['body'][lane]['pending']=1
            s._publish_market_digest();self.assertEqual(self.packets(),[])
            s.last_list['body'][lane]['pending']=0
        for target,attribute,value in [(s,'active',True),(s,'stopping',True),(s,'analyzer',None),
                (s.model_work,'failed',True),(s.model_work,'failures',1),
                (s.model_work,'admitted',False),(s.model_work,'round_id',0)]:
            with patch.object(target,attribute,value):
                s._publish_market_digest();self.assertEqual(self.packets(),[])
        s.classifier.enabled=False
        s._publish_market_digest();self.assertEqual(self.packets(),[])
        s.classifier.enabled=True
        s.last_list['body']['items']=[]
        s._publish_market_digest();self.assertEqual(self.packets(),[])

    def test_disable_during_aggregation_is_checked_again_before_publish(self):
        s=self.make()
        def build(*args):
            body=build_digest(*args)
            s.classifier.enabled=False
            return body
        with patch('back.scheduler.build_digest',side_effect=build):
            s._publish_market_digest()
        self.assertEqual(self.packets(),[])
        self.assertFalse(s.model_work.digest_sent)

    def test_outbox_rejection_does_not_consume_once_flag(self):
        s=self.make()
        with patch.object(self.sink,'put',return_value=False):s._publish_market_digest()
        self.assertFalse(s.model_work.digest_sent)
        s._publish_market_digest()
        self.assertTrue(s.model_work.digest_sent)

    def test_real_coordinator_emits_after_analysis_result_and_not_resends(self):
        s=self.make()
        s.last_list['body']['items'][0]['analysis']=None
        s.classify_cache[item(1)['link']]='finance'
        s.last_list['body']['analysis']['pending']=1
        s.pending_refresh=False;s.next_round=s.clock()+600
        s.analysis_in_flight.add(item(1)['link'])
        s.coordinator.start()
        self.addCleanup(lambda:s.coordinator.join(2))
        # addCleanup LIFO: stop before join.
        self.addCleanup(s.stop)
        self.assertFalse(any(p.get('topic')==TOPIC for p in self.packets()))
        s._submit_classification(AnalysisResult({item(1)['link']:analysis()},(item(1)['link'],),1))
        eventually(lambda:any(p.get('topic')==TOPIC for p in self.packets()))
        self.assertEqual(sum(p.get('topic')==TOPIC for p in self.packets()),1)
        s._submit_classification(AnalysisResult({item(1)['link']:analysis()},(),1))
        eventually(lambda:s.processed_results>=2)
        self.assertEqual(sum(p.get('topic')==TOPIC for p in self.packets()),1)
        self.assertFalse(any(p.get('topic')=='news.fetched' for p in self.packets()))

    def test_cached_first_list_broadcasts_without_model_requests(self):
        s=self.make(); rows=[item(1)]
        s.last_list=None;s.model_work=None;s.round_id=0
        s.classify_cache[rows[0]['link']]='finance'
        s.analysis_cache[rows[0]['link']]=analysis()
        s.caches=[Cache([rows[0]] if i==0 else [],available=True) for i in range(len(FEEDS))]
        s.start()
        self.addCleanup(lambda:[t.join(2) for t in s.workers+[s.coordinator]+s.classify_workers])
        self.addCleanup(s.stop)
        eventually(lambda:any(p.get('topic')==TOPIC for p in self.packets()))
        topics=[p.get('topic') for p in self.packets() if p['t']=='publish']
        self.assertEqual(topics,['news.fetched',TOPIC])
        self.assertEqual(sum(s.model_work.requests.values()),0)
