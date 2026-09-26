"""v0.8 source retention, quotas and wire-budget boundaries (no live network)."""
from collections import Counter, OrderedDict
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import tempfile
import unittest

from back import feedparse as fp
from back.fetch import Result
from back.news import preflight, Outbox
from tests import test_scheduler as helpers
from tests.test_scheduler import eventually, ok

NOW = datetime(2026, 9, 27, 12, tzinfo=timezone.utc)
FEED = dict(name='LTN', url='https://news.ltn.com.tw/rss/all.xml', retain_hours=3, max_items=120)


def item(n, age=0, source='LTN', guessed=False):
    return dict(title=str(n), link=f'https://news.ltn.com.tw/{n}', summary='', source=source,
                published=fp._iso(NOW - timedelta(minutes=age)), time_guessed=guessed)


class RetentionTests(unittest.TestCase):
    def test_omitted_items_cutoff_fresh_versions_and_no_mutation(self):
        old = [item('gone', 181), item('boundary', 180), item('omitted', 100), item('updated', 90)]
        fresh = [dict(item('updated', 90), title='corrected'), item('new')]
        original = deepcopy((old, fresh))
        result = fp.retain_items(fresh, old, FEED, NOW)
        self.assertEqual([x['title'] for x in result], ['new', 'corrected', 'omitted', 'boundary'])
        self.assertEqual((old, fresh), original)
        self.assertEqual(fp.retain_items(fresh, old, dict(name='normal'), NOW), fresh)

    def test_duplicate_current_link_keeps_newest_regardless_of_feed_order(self):
        current = [dict(item('same', 1), title='new'), dict(item('same', 2), title='old')]
        expected = [current[0]]
        self.assertEqual(fp.retain_items(current, [], FEED, NOW), expected)
        self.assertEqual(fp.retain_items(current[::-1], [], FEED, NOW), expected)

    def test_120_cache_and_merge_cap_other_sources_stay_60(self):
        items = [item(i, i) for i in range(150)]
        retained = fp.retain_items(items, [], FEED, NOW)
        self.assertEqual(len(retained), 120)
        self.assertEqual({x['title'] for x in retained}, {str(i) for i in range(120)})
        ordinary = [dict(x, source='other', link=x['link']+'/other') for x in items]
        result = fp.merge_items([retained, ordinary], [FEED, dict(name='other', url='https://example.com')])
        self.assertEqual(Counter(x['source'] for x in result), {'LTN':120, 'other':60})

    def test_first_seen_is_not_renewed_by_retention_or_lru_reads(self):
        xml = b'<rss><channel><item><title>A</title><link>https://news.ltn.com.tw/a</link></item></channel></rss>'
        items, seen = fp.parse_feed(xml, FEED['url'], 'LTN', OrderedDict(), NOW)
        later, later_seen = fp.parse_feed(xml, FEED['url'], 'LTN', seen, NOW+timedelta(hours=4))
        self.assertEqual(later[0]['published'], items[0]['published'])
        self.assertEqual(later_seen, seen)
        self.assertEqual(fp.retain_items(later, items, FEED, NOW+timedelta(hours=4)), later)
        self.assertEqual(fp.retain_items([], items, FEED, NOW+timedelta(hours=4)), [])
        self.assertTrue(items[0]['time_guessed'])

    def test_shipped_sources_and_retention_are_explicit(self):
        feeds, error = preflight(Path(__file__).parents[1]/'back/feeds.json')
        self.assertIsNone(error)
        by_name = {feed['name']: feed for feed in feeds}
        self.assertNotIn('聯合新聞網 即時', by_name)
        self.assertEqual(len(feeds), 16)
        self.assertEqual(by_name['ETtoday 即時']['link_domains'], ['ettoday.net'])
        self.assertEqual(by_name['RFI 中文']['link_domains'], ['rfi.fr'])
        self.assertEqual(by_name['新頭殼']['url'], 'https://newtalk.tw/rss/all')
        retained = [feed for feed in feeds if 'retain_hours' in feed]
        self.assertEqual([(feed['name'], feed['retain_hours'], feed['max_items']) for feed in retained], [('自由時報即時', 3, 120)])

    def test_preflight_retention_options(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'feeds.json'
            for extra in [dict(retain_hours=x) for x in [None, True, 0, -1, 25, '3', float('nan'), float('inf')]] + [dict(retain_hours=3, max_items=x) for x in [True, 0, 121, 1.5, '120']] + [dict(max_items=120)]:
                with self.subTest(extra=extra):
                    path.write_text(json.dumps([dict(name='A', url='https://example.com', **extra)]))
                    self.assertIsNotNone(preflight(path)[1])
            for extra in [dict(retain_hours=0.5), dict(retain_hours=24, max_items=120), {}]:
                path.write_text(json.dumps([dict(name='A', url='https://example.com', **extra)]))
                self.assertIsNone(preflight(path)[1])

    def test_all_longest_fields_550_items_17_sources_5_topics_fit_host(self):
        char = '\U0010ffff'
        names = [char*62 + f'{i:02}' for i in range(17)]
        items = []
        for i in range(fp.MAX_ITEMS_LIST):
            prefix = f'https://example.com/{i:03x}/'
            items.append(dict(item(i), title=char*300, summary=char*200,
                              link=prefix+char*(2048-len(prefix)), source=names[i%17],
                              category=fp.LONGEST_CATEGORY, analysis=deepcopy(fp.MAX_ANALYSIS),
                              event=f'{i:012x}', event_size=fp.MAX_ITEMS_LIST, topic='f'*12, tone='negative'))
        # Conservative maxima even for counters that cannot all peak together.
        topics = [dict(id=f'{i:012x}', title=char*300, sources=550, count=550,
                       tone=dict(positive=550, negative=550, neutral=550, mixed=550)) for i in range(5)]
        packet = dict(t='msg', seq=2**53-1, body=dict(op='list', at=NOW.isoformat(timespec="microseconds"), items=items,
                      sources=[dict(name=n, outlet=char*64, ok=False, error=char*200,
                                    last_success=NOW.isoformat(timespec="microseconds"), count=550) for n in names],
                      classify=dict(enabled=True, pending=550), analysis=dict(pending=550),
                      events=dict(pending=550*549//2), topics=dict(pending=550, tone_pending=550, list=topics),
                      model=dict(state='paused', reason='failed', failure='connection')))
        self.assertEqual(len(items), 550)
        self.assertGreater(len(fp.packet_bytes(packet)), 1<<20)
        fitted = fp.fit_packet(packet)
        self.assertLess(len(fitted['body']['items']), 550)
        self.assertGreater(len(fitted['body']['items']), 0)
        self.assertLessEqual(len(fp.packet_bytes(fitted)), fp.MAX_PACKET)
        self.assertLess(fp.MAX_PACKET, 1<<20)
        self.assertEqual(fp.packet_bytes(fitted), Outbox.encode(fitted))

    def test_full_list_fields_fit_and_future_decoration_keeps_same_items(self):
        # Include every future item field and worst topic/model reservation.
        items = [dict(item(i), title='\U0001f600'*300, summary='\U0001f600'*200,
                      link='https://example.com/'+str(i).zfill(4)+'x'*2024,
                      source='源'*64, category='', analysis=None, event=f'{i:012x}', event_size=1,
                      ) for i in range(fp.MAX_ITEMS_LIST)]
        packet = dict(t='msg', seq=2**53-1, body=dict(op='list', at=fp._iso(NOW), items=items,
                     sources=[dict(name='源'*64, outlet='媒'*64, error='錯'*200, ok=False,
                                   last_success=fp._iso(NOW), count=0) for _ in range(32)],
                     classify=dict(enabled=True, pending=len(items)), analysis=dict(pending=len(items)),
                     events=dict(pending=fp.MAX_ITEMS_LIST*2), topics=dict(pending=fp.MAX_ITEMS_LIST, tone_pending=fp.MAX_ITEMS_LIST, list=[]),
                     model=dict(state='working')))
        self.assertGreater(len(fp.packet_bytes(packet)), fp.MAX_PACKET)
        first = fp.fit_packet(packet)
        size = len(fp.packet_bytes(first))
        self.assertLessEqual(size, fp.MAX_PACKET)
        self.assertEqual(fp.packet_bytes(first), Outbox.encode(first))
        self.assertLess(fp.MAX_PACKET, 1<<20)
        for x in first['body']['items']:
            x.update(category=fp.LONGEST_CATEGORY, analysis=deepcopy(fp.MAX_ANALYSIS), event='f'*12, event_size=fp.MAX_ITEMS_LIST,
                     topic='f'*12, tone='negative')
        second = fp.fit_packet(first)
        self.assertEqual([x['link'] for x in first['body']['items']], [x['link'] for x in second['body']['items']])
        self.assertLessEqual(len(fp.packet_bytes(second)), fp.MAX_PACKET)


class RetentionSchedulerTests(unittest.TestCase):
    setUp = helpers.SchedulerTests.setUp
    tearDown = helpers.SchedulerTests.tearDown
    create = helpers.SchedulerTests.create
    round = helpers.SchedulerTests.round
    def test_current_rss_membership_bounded_and_ordinary_feed_still_replaces(self):
        from tests.test_scheduler import analysis_feed
        batches = [0]
        def fetch(source, _):
            return analysis_feed([f'{source}-new']) if batches[0] else analysis_feed([f'{source}-{i}' for i in range(150)])
        clock = [NOW]
        scheduler, sink, _ = self.create(fetch, count=2, now=lambda:clock[0])
        scheduler.feeds[0].update(retain_hours=3, max_items=120)
        scheduler.start()
        self.round(sink)
        cache = scheduler.snapshot()[0]
        self.assertEqual(len(cache.items), 120)
        self.assertEqual(len(cache.current_keys), 120)
        eventually(lambda: not scheduler.active)
        clock[0] += timedelta(hours=4)
        batches[0] = 1
        scheduler.refresh()
        self.round(sink)
        caches = scheduler.snapshot()
        self.assertEqual([x['title'] for x in caches[0].items], ['0-new'])
        self.assertEqual([x['title'] for x in caches[1].items], ['1-new'])
        self.assertEqual(len(caches[0].current_keys), 1)
        self.assertEqual(caches[1].current_keys, frozenset())
        self.assertLessEqual(len(caches[0].first_seen), 1000)

    def test_success_omission_304_failure_and_expiry(self):
        clock = [NOW]
        responses = iter([ok('a'), ok('b'), Result('not_modified'), Result('error', error='offline'), Result('not_modified')])
        scheduler, sink, _ = self.create(lambda *_: next(responses), now=lambda:clock[0])
        scheduler.feeds[0].update(retain_hours=3, max_items=120)
        scheduler.start()
        first = self.round(sink)
        self.assertEqual([x['title'] for x in first['items']], ['a'])
        for hours, expected, success in [(1, ['b','a'], True), (2, ['b','a'], True), (3.5, ['b'], False), (5, ['b'], True)]:
            eventually(lambda: not scheduler.active)
            clock[0] = NOW+timedelta(hours=hours)
            scheduler.refresh()
            body = self.round(sink)
            self.assertEqual([x['title'] for x in body['items']], expected)
            self.assertEqual(body['sources'][0]['ok'], success)
            stamp = (clock[0] if success else NOW+timedelta(hours=2)).isoformat()
            self.assertEqual(body['sources'][0]['last_success'], stamp)
            self.assertLessEqual(len(scheduler.snapshot()[0].items), 120)
            self.assertEqual(scheduler.snapshot()[0].current_keys, frozenset({'https://example.com/b'}))

