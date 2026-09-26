"""§20.2 CPU bounds and trusted cross-source deduplication."""
from collections import Counter
from datetime import datetime, timezone
from html import unescape
from html.parser import HTMLParser
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import Mock

from back import feedparse as fp
from back.news import preflight

FIXTURES = Path(__file__).with_name('fixtures')
NOW = datetime(2026, 9, 26, tzinfo=timezone.utc)


class LegacyPlain(HTMLParser):
    """Pre-S1 oracle, used only with benign compatibility fixtures."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
    def handle_data(self, value): self.parts.append(value)
    def handle_starttag(self, tag, attrs):
        if tag in ('br', 'p', 'div', 'li'): self.parts.append(' ')
    def handle_endtag(self, tag):
        if tag in ('p', 'div', 'li'): self.parts.append(' ')


def legacy_plain(value, limit):
    parser = LegacyPlain()
    parser.feed(value[:8192]); parser.close()
    return ' '.join(unescape(''.join(parser.parts)).split())[:limit]


def hostile_feed(field, count=None):
    item = (f'<item><title><![CDATA[{field}]]></title><link>https://e.example/{{i}}</link>'
            f'<description><![CDATA[{field}]]></description></item>')
    n = count or (2 * 1024 * 1024 - 200) // (len(item.encode()) + 4)
    return ('<rss><channel>' + ''.join(item.replace('{i}',str(i)) for i in range(n))
            + '</channel></rss>').encode(), n


class ParseSecurityTests(unittest.TestCase):
    def test_full_feed_cpu_under_two_seconds_for_unfinished_and_dense_markup(self):
        for pattern in ('<a\t', '<a x="', '<!--', '</a ', '<![', '<a ', '< ', '<i>x</i>', '&#', '&amp;'):
            with self.subTest(pattern=pattern):
                field = 'x' + pattern * (8192 // len(pattern) + 1)
                data, n = hostile_feed(field)
                self.assertLessEqual(len(data), 2*1024*1024)
                started = time.process_time()
                items, _ = fp.parse_feed(data, 'https://e.example/', 'X', {}, NOW)
                elapsed = time.process_time() - started
                self.assertLess(elapsed, 2, f'{pattern!r}: {elapsed:.3f}s CPU')
                self.assertEqual(len(items), n)
                self.assertTrue(all(len(i['title']) <= 300 and len(i['summary']) <= 200 for i in items))
        # Many smaller fields must also stay bounded; not just the 127-entry PoC.
        data, n = hostile_feed('x' + '<a\t'*100, count=2500)
        started = time.process_time()
        items, _ = fp.parse_feed(data, 'https://e.example/', 'X', {}, NOW)
        self.assertLess(time.process_time() - started, 2)
        self.assertEqual(len(items), n)

    def test_malformed_field_falls_back_to_text_without_losing_other_fields_or_entries(self):
        data = b'''<rss><channel>
        <item><title><![CDATA[<![<![ broken]]></title><link>/one</link><description>&lt;b&gt;good&lt;/b&gt;</description></item>
        <item><title>&lt;b&gt;next&lt;/b&gt;</title><link>/two</link><description><![CDATA[before <a x="unfinished]]></description></item>
        </channel></rss>'''
        items, _ = fp.parse_feed(data, 'https://e.example/', 'X', {}, NOW)
        self.assertEqual([(i['title'],i['summary']) for i in items],
                         [('<![<![ broken','good'),('next','before <a x="unfinished')])

    def test_plain_matches_legacy_on_xml_fixtures_snapshot_and_normal_html(self):
        fields = []
        for name in ('rss.xml','atom.xml'):
            def visit(node):
                if node.tag.split('|')[-1] in ('title','description','summary','content'):
                    fields.append(node.text())
                for child in node.children: visit(child)
            visit(fp._xml((FIXTURES/name).read_bytes()))
        snapshot = json.loads((FIXTURES/'events-300-2026-09-24.json').read_text())
        for item in snapshot: fields.extend([item['title'],item['summary']])
        fields.extend(['<p>A &amp; B</p><div> C<br>D</div>', '<P><b>😀𠮷</b>&nbsp;尾</P>',
            '<a href="https://e/?x=>&y=1" title=\'1 > 0\'>連結</a>',
            '<!-- ignore -- >字<i>尾</i>', '<![CDATA[ignored]]>尾',
            '<!DOCTYPE html><html><body>text</body></html>', '<?xml version="1.0"?>text',
            '<script>if (x < 2) a="&amp;";</script>尾', '<style>x > y {color:red}</style>尾',
            '<script>unclosed text', '<br/><p/>尾', '&amp;amp; &lt;b&gt;X&lt;/b&gt;', '2 < 3 & 5 > 4'])
        for value in fields:
            for limit in (200,300):
                with self.subTest(value=value[:80], limit=limit):
                    self.assertEqual(fp.plain(value,limit),legacy_plain(value,limit))


class MergeSecurityTests(unittest.TestCase):
    @staticmethod
    def item(source, link, published='2026-09-25T00:00:00.000000Z', title='real'):
        return dict(source=source,link=link,published=published,title=title,summary='',time_guessed=False)

    def test_utm_impersonation_cannot_steal_any_of_five_sources_even_when_evil_is_first(self):
        victims = [[self.item(f'V{s}',f'https://v{s}.example/a/{i}') for i in range(60)] for s in range(5)]
        evil = [dict(item,source='EVIL',link=item['link']+'?utm_x=1',
                     published='2026-09-26T00:00:00.000000Z',title='FAKE') for source in victims for item in source]
        feeds = [{'name':'EVIL','url':'https://evil.example/rss'}] + [
            {'name':f'V{s}','url':f'https://v{s}.example/rss'} for s in range(5)]
        for lists, config in [(victims+[evil],()),([evil]+victims,feeds),(victims+[evil],feeds)]:
            with self.subTest(evil_first=lists[0] is evil, configured=bool(config)):
                result = fp.merge_items(lists,config)
                self.assertEqual(Counter(i['source'] for i in result),{f'V{s}':60 for s in range(5)})
                self.assertTrue(all(i['title']=='real' for i in result))
                self.assertEqual(len(result),300)

    def test_publisher_alias_and_domain_boundaries_then_feed_order_not_timestamp(self):
        feeds=[{'name':'EVIL','url':'https://evil.example/rss'},
               {'name':'中央社 政治','url':'https://feeds.feedburner.com/politics','link_domains':['cna.com.tw']},
               {'name':'中央社 財經','url':'https://feeds.feedburner.com/finance','link_domains':['cna.com.tw']}]
        for host, winner in [('www.cna.com.tw','中央社 政治'),('cna.com.tw','中央社 政治'),
                             ('cna.com.tw.evil.example','EVIL'),('notcna.com.tw','EVIL')]:
            real=self.item('中央社 政治',f'https://{host}/a')
            finance=dict(real,source='中央社 財經',published='2026-09-26T00:00:00.000000Z')
            evil=dict(finance,source='EVIL',link=finance['link']+'?utm_x=1')
            result=fp.merge_items([[finance],[real],[evil]],feeds)
            self.assertEqual(len(result),1)
            self.assertEqual(result[0]['source'],winner)
        # A feed without aliases uses its configured host (www stripped), not a link-derived host.
        owned=self.item('OWNER','https://news.owner.example/a')
        forged=dict(owned,source='EVIL',published='2099-01-01T00:00:00.000000Z')
        self.assertEqual(fp.merge_items([[forged],[owned]], [feeds[0],{'name':'OWNER','url':'https://www.owner.example/rss'}]),[owned])

    def test_same_source_newest_still_wins_and_equal_dates_stay_stable(self):
        old=self.item('A','https://a.example/a')
        new=dict(old,published='2026-09-26T00:00:00.000000Z',title='new',link=old['link']+'?utm_x=1')
        tied=dict(new,title='tie')
        self.assertEqual(fp.merge_items([[old,new,tied]]),[new])

    def test_scheduler_passes_trusted_feed_domains_to_merge(self):
        from back.scheduler import Scheduler, Cache
        victim=self.item('OWNER','https://publisher.example/a')
        forged=dict(victim,source='EVIL',title='FAKE',published='2026-09-26T00:00:00.000000Z')
        feeds=[{'name':'EVIL','url':'https://evil.example/rss'},
               {'name':'OWNER','url':'https://hosted.example/rss','link_domains':['publisher.example']}]
        outbox=Mock(); outbox.put.return_value=True
        scheduler=Scheduler(feeds,Mock(),outbox,1)
        packet=scheduler._emit([Cache([forged],available=True),Cache([victim],available=True)],[])
        self.assertEqual(len(packet['body']['items']),1)
        self.assertEqual(packet['body']['items'][0]['source'],'OWNER')
        self.assertEqual(packet['body']['items'][0]['title'],'real')
        scheduler.stop()

    def test_domain_config_is_local_validated_and_current_hosted_publishers_are_declared(self):
        path=Path(__file__).parents[1]/'back/feeds.json'
        feeds,error=preflight(path)
        self.assertIsNone(error)
        for feed in feeds:
            if feed['name'].startswith('中央社'): self.assertEqual(feed['link_domains'],['cna.com.tw'])
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'feeds.json'
            for domains in ('cna.com.tw',['*.cna.com.tw'],['cna.com.tw/evil'],[''],['CNA.COM.TW'],[5],['a..b']):
                path.write_text(json.dumps([{'name':'A','url':'https://a.example/rss','link_domains':domains}]))
                self.assertIsNotNone(preflight(path)[1])
