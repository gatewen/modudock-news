from collections import OrderedDict
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
import unittest
from unittest.mock import patch
from xml.parsers import expat

from back import feedparse as fp
from back.news import Outbox

FIXTURES = Path(__file__).with_name("fixtures")
NOW = datetime(2026, 9, 21, tzinfo=timezone.utc)
BASE = "https://example.com/redirected/feed.xml"


def rss(content):
    return ("<rss><channel>" + content + "</channel></rss>").encode()


def entry(title="標題", link="/story", extra=""):
    return f"<item><title>{title}</title><link>{link}</link>{extra}</item>"


def parse(data, seen=None, now=NOW):
    return fp.parse_feed(data, BASE, "來源", OrderedDict() if seen is None else seen, now)


class ParseTests(unittest.TestCase):
    def test_rss_fixture_normalization_and_drops(self):
        items, seen = parse((FIXTURES / "rss.xml").read_bytes(), now=NOW + timedelta(hours=4))
        self.assertEqual(len(items), 2)
        self.assertEqual(items[0], dict(title="新聞 標題", link="https://example.com/story?utm_source=rss&a=1#top",
                         published="2026-09-21T02:00:00.000000Z", summary="摘要 & 內容 第二段",
                         source="來源", time_guessed=False))
        self.assertEqual(items[1]["link"], "https://example.com/undated")
        self.assertTrue(items[1]["time_guessed"])
        self.assertEqual(len(seen), 1)

    def test_atom_priority_and_namespace(self):
        items, _ = parse((FIXTURES / "atom.xml").read_bytes(), now=NOW + timedelta(hours=4))
        self.assertEqual(len(items), 3)
        self.assertEqual(items[0]["link"], "https://example.com/redirected/article")
        self.assertEqual(items[0]["published"], "2026-09-21T02:00:00.000000Z")
        self.assertEqual(items[0]["summary"], "摘要")
        self.assertEqual(items[1]["link"], "https://example.com/fallback")
        self.assertEqual(items[1]["summary"], "正文 粗體")
        self.assertEqual(items[1]["published"], "2026-09-20T00:00:00.000000Z")
        self.assertEqual(items[2]["link"], "https://example.com/implicit")

    def test_first_seen_two_rounds_and_no_input_mutation(self):
        data = rss(entry(extra="<pubDate>not a date</pubDate>"))
        original = OrderedDict()
        items1, seen1 = parse(data, original)
        items2, seen2 = parse(data, seen1, datetime(2026, 10, 1, tzinfo=timezone.utc))
        self.assertEqual(original, {})
        self.assertEqual(items1, items2)
        self.assertEqual(seen1, seen2)
        self.assertIsNot(seen1, seen2)
        self.assertTrue(items2[0]["time_guessed"])

    def test_first_seen_oldest_insertion_eviction(self):
        seen = OrderedDict((f"https://example.com/{i}", "2026-01-01T00:00:00.000000Z") for i in range(1000))
        _, candidate = parse(rss(entry(link="/new")), seen)
        self.assertEqual(len(candidate), 1000)
        self.assertNotIn("https://example.com/0", candidate)
        self.assertIn("https://example.com/0", seen)

    def test_first_seen_over_capacity_does_not_cascade_with_lru(self):
        data = rss(''.join(entry(link=f'/{i}') for i in range(1001)))
        first, old = parse(data)
        original = deepcopy(old)
        second, new = parse(data, old, now=NOW + timedelta(minutes=10))
        self.assertEqual(old, original)
        self.assertEqual(len(new), 1000)
        self.assertEqual([i for i, (a, b) in enumerate(zip(first, second))
                          if a['published'] != b['published']], [0])
        self.assertEqual(list(new), list(old))
        self.assertTrue(all(item['time_guessed'] for item in second))
        # Subsequent rounds lose only the one truly evicted timestamp, not all 1001.
        third, _ = parse(data, new, now=NOW + timedelta(minutes=20))
        self.assertEqual([i for i, (a, b) in enumerate(zip(second, third))
                          if a['published'] != b['published']], [0])

    def test_first_seen_lru_preserves_present_item_across_rounds(self):
        seen = OrderedDict((f'https://example.com/{i}', '2026-01-01T00:00:00.000000Z') for i in range(1000))
        original = deepcopy(seen)
        data = rss(entry(link='/0') + entry(link='/new'))
        first, candidate = parse(data, seen)
        self.assertEqual(seen, original)
        self.assertIn('https://example.com/0', candidate)
        self.assertNotIn('https://example.com/1', candidate)
        self.assertEqual(list(candidate)[-2:], ['https://example.com/0', 'https://example.com/new'])
        second, _ = parse(data, candidate, now=NOW + timedelta(hours=1))
        self.assertEqual(first, second)

    def test_future_dates_over_ten_minutes_use_stable_first_seen(self):
        for date, guessed in [('2026-09-21T00:09:59Z', False),
                              ('2026-09-21T00:10:00Z', False),
                              ('2026-09-21T08:10:00+08:00', False),
                              ('2026-09-21T00:10:00.000001Z', True),
                              ('2099-01-01T00:00:00Z', True),
                              ('1970-01-01T00:00:00Z', False)]:
            with self.subTest(date=date):
                items, seen = parse(rss(entry(extra=f'<pubDate>{date}</pubDate>')))
                self.assertEqual(items[0]['time_guessed'], guessed)
                self.assertEqual(items[0]['published'], fp._iso(NOW) if guessed else fp._date(date))
                self.assertEqual(len(seen), int(guessed))
        data = rss(entry(extra='<pubDate>2099-01-01T00:00:00Z</pubDate>'))
        first, seen = parse(data)
        second, _ = parse(data, seen, now=NOW + timedelta(minutes=10))
        self.assertEqual(first, second)

    def test_display_preserves_zero_width_characters_and_zwj(self):
        title = '台\u200b積\u200c電\u2060晶\ufeff片👩\u200d💻'
        items, _ = parse(rss(entry(title, extra=f'<description>{title}</description>')))
        self.assertEqual(items[0]['title'], title)
        self.assertEqual(items[0]['summary'], title)

    def test_bad_xml_root_and_namespace_rejected(self):
        for data in (b"", b"<rss>", b"<html/>", b'<feed xmlns="urn:wrong"/>'):
            with self.subTest(data=data), self.assertRaises(fp.FeedError):
                parse(data)

    def test_utf16_dtd_rejected_before_expansion(self):
        # Stored as readable text; the parser receives real BOM-bearing UTF-16.
        data = (FIXTURES / "doctype.xml").read_text().encode("utf-16")
        control = expat.ParserCreate()
        control_text = []
        control.CharacterDataHandler = control_text.append
        control.Parse(data, True)
        self.assertIn("EXPANDED_SENTINEL", "".join(control_text))
        original_factory = expat.ParserCreate
        observed = []

        class ObservedParser:
            def __init__(self, *args, **kwargs):
                object.__setattr__(self, "parser", original_factory(*args, **kwargs))

            def __setattr__(self, key, value):
                if key == "CharacterDataHandler":
                    original = value
                    def value(text):
                        observed.append(text)
                        original(text)
                setattr(self.parser, key, value)

            def Parse(self, *args):
                return self.parser.Parse(*args)

        with patch.object(fp.expat, "ParserCreate", ObservedParser):
            with self.assertRaisesRegex(fp.FeedError, "DTD/entity forbidden"):
                parse(data)
        self.assertNotIn("EXPANDED_SENTINEL", "".join(observed))

    def test_dtd_internal_external_and_utf16_plain(self):
        for declaration in ('<!DOCTYPE rss>', '<!DOCTYPE rss SYSTEM "file:///etc/passwd">',
                            '<!DOCTYPE rss [<!ENTITY x "value">]>'):
            with self.subTest(declaration=declaration), self.assertRaisesRegex(fp.FeedError, "DTD/entity"):
                parse((declaration + '<rss/>').encode())
        items, _ = parse(('<?xml version="1.0" encoding="UTF-16"?>' + rss(entry()).decode()).encode("utf-16"))
        self.assertEqual(items[0]["title"], "標題")

    def test_element_limit_boundary(self):
        parse(b"<rss>" + b"<x/>" * 19999 + b"</rss>")
        with self.assertRaisesRegex(fp.FeedError, "element limit"):
            parse(b"<rss>" + b"<x/>" * 20000 + b"</rss>")

    def test_depth_limit_boundary(self):
        parse(b"<rss>" + b"<x>" * 31 + b"</x>" * 31 + b"</rss>")
        with self.assertRaisesRegex(fp.FeedError, "depth limit"):
            parse(b"<rss>" + b"<x>" * 32 + b"</x>" * 32 + b"</rss>")

    def test_text_limit_accumulates_across_callbacks(self):
        parse(b"<rss>" + b"a" * (256 * 1024) + b"</rss>")
        # Entity references force multiple CharacterData callbacks.
        with self.assertRaisesRegex(fp.FeedError, "text node limit"):
            parse(b"<rss>" + b"a" * (128 * 1024) + b"&amp;" + b"b" * (128 * 1024) + b"</rss>")
        with self.assertRaisesRegex(fp.FeedError, "text node limit"):
            parse(("<rss>" + "中" * 90000 + "</rss>").encode())

    def test_field_limits_empty_title_and_link_validation(self):
        items, _ = parse(rss(entry("中" * 301, "/" + "a" * 2028,
                                  "<description>文" + "文" * 200 + "</description>")))
        self.assertEqual(len(items[0]["title"]), 300)
        self.assertEqual(len(items[0]["summary"]), 200)
        self.assertLessEqual(len(items[0]["link"]), 2048)
        for title, link in ((" ", "/x"), ("x", ""), ("x", "file:///x"),
                            ("x", "http://[bad"), ("x", "https://example.com/" + "x" * 2048)):
            with self.subTest(link=link):
                self.assertEqual(parse(rss(entry(title, link)))[0], [])

    def test_date_fallbacks_and_utc(self):
        items, _ = parse(rss(entry(extra="<updated>2026-09-21T03:00:00</updated>")), now=NOW + timedelta(hours=4))
        self.assertEqual(items[0]["published"], "2026-09-21T03:00:00.000000Z")
        items, _ = parse(rss(entry(extra="<pubDate>bad</pubDate><updated>2027-01-01T00:00:00Z</updated>")))
        self.assertTrue(items[0]["time_guessed"])

    def test_parse_failure_does_not_change_cache(self):
        seen = OrderedDict([("old", "time")])
        with self.assertRaises(fp.FeedError):
            parse(rss(entry())[:-5], seen)
        self.assertEqual(seen, {"old": "time"})


class MergeAndSizeTests(unittest.TestCase):
    def item(self, title, link, date="2026-09-21T00:00:00.000000Z", source="A"):
        return dict(title=title, link=link, published=date, source=source, summary="", time_guessed=False)

    def test_tracking_dedup_newest_and_source_order(self):
        old = self.item("old", "https://example.com/x?a=1&utm_source=x#top")
        newer = self.item("new", "https://example.com/x?a=1&fbclid=y", "2026-09-22T00:00:00.000000Z", "Z")
        tied = dict(newer, title="tie", source="A")
        self.assertEqual(fp.merge_items([[old], [newer], [tied]]), [tied])  # A owns the key; its newest wins.
        self.assertEqual(fp.dedup_key(old["link"]), "https://example.com/x?a=1")

    def test_sort_ties_stable_and_300_cap(self):
        items = [self.item(f"{i:03d}", f"https://example.com/{i}", source=chr(65 + i % 5)) for i in range(305)]
        first = fp.merge_items([list(reversed(items))])
        self.assertEqual(first, fp.merge_items([items]))
        self.assertEqual(len(first), 300)
        self.assertEqual([(x["source"], x["title"]) for x in first], sorted((x["source"], x["title"]) for x in items if int(x["title"]) < 300))

    def test_size_guard_reachable_and_matches_outbox(self):
        items = [dict(self.item("中" * 300, "https://example.com/" + "x" * 2028, source="源" * 64), summary="文" * 200, category="entertainment") for _ in range(300)]
        self.assertEqual(len(items[0]["link"]), 2048)
        sources = [dict(name="源" * 64 if i == 0 else str(i), ok=False, error="錯" * 200, count=0) for i in range(32)]
        packet = dict(t="msg", seq=2**53 - 1, body=dict(op="list", items=items, sources=sources, count=300))
        original = deepcopy(packet)
        self.assertGreater(len(fp.packet_bytes(packet)), 900 * 1024)
        fitted = fp.fit_packet(packet)
        self.assertLessEqual(len(fp.packet_bytes(fitted)), 900 * 1024)
        self.assertEqual(fp.packet_bytes(fitted), Outbox.encode(fitted))
        remaining = len(fitted["body"]["items"])
        self.assertGreater(remaining, 0)
        self.assertLess(remaining, 300)
        self.assertEqual(fitted["body"]["items"], items[:remaining])
        self.assertEqual(fitted["body"]["count"], remaining)
        self.assertEqual(fitted["body"]["sources"][0]["count"], remaining)
        self.assertEqual(packet, original)

    def test_oversized_envelope_is_error(self):
        with self.assertRaisesRegex(ValueError, "without items"):
            fp.fit_packet(dict(t="msg", seq=4, body=dict(items=[], extra="x" * (900 * 1024))))


class ClassifySizeTests(unittest.TestCase):
    def test_pending_recount_after_size_trim_and_disabled_is_zero(self):
        items = [dict(title="中" * 300, link="https://example.com/" + "x" * 2028,
                      summary="文" * 200, source="源" * 64, published="2026-09-22",
                      time_guessed=False, category="" if i % 2 else "entertainment")
                 for i in range(200)]
        packet = dict(t="msg", seq=42, body=dict(op="list", items=items,
                      classify={"enabled": True, "pending": 100}))
        self.assertGreater(len(fp.packet_bytes(packet)), 900 * 1024)
        fitted = fp.fit_packet(packet)
        self.assertLess(len(fitted["body"]["items"]), 200)
        self.assertEqual(fitted["body"]["classify"]["pending"],
                         sum(i["category"] == "" for i in fitted["body"]["items"]))
        self.assertLess(fitted["body"]["classify"]["pending"], 100)
        packet["body"]["classify"]["enabled"] = False
        self.assertEqual(fp.fit_packet(packet)["body"]["classify"]["pending"], 0)


class SourceFloorTests(unittest.TestCase):
    item = MergeAndSizeTests.item
    def test_old_source_keeps_latest_three_with_300_total(self):
        recent = [self.item(str(i), f'https://example.com/new/{i}', '2026-09-25', f'A{i % 5}') for i in range(300)]
        old = [self.item(str(i), f'https://example.com/old/{i}', f'2026-09-{i + 1:02d}', 'B') for i in range(10)]
        result = fp.merge_items([recent, old])
        self.assertEqual(len(result), fp.MAX_ITEMS_LIST)
        self.assertEqual([i['title'] for i in result if i['source'] == 'B'], ['9', '8', '7'])
        self.assertEqual([i['published'] for i in result], sorted((i['published'] for i in result), reverse=True))
        self.assertEqual(result, fp.merge_items([recent[::-1], old[::-1]]))

    def test_floor_uses_dedup_winner_source_and_all_available_when_under_three(self):
        old = [self.item(str(i), f'https://example.com/{i}', '2026-09-01', 'A') for i in range(4)]
        new = [dict(old[0], published='2026-09-25', source='B')]
        with patch.object(fp, 'MAX_ITEMS_LIST', 4):
            result = fp.merge_items([old, new], [{"name":"B","url":"https://b.example/rss"},
                                                   {"name":"A","url":"https://a.example/rss"}])
        self.assertEqual(len(result), 4)
        self.assertEqual([i['source'] for i in result].count('A'), 3)
        self.assertEqual([i['source'] for i in result].count('B'), 1)
        self.assertEqual(len({fp.dedup_key(i['link']) for i in result}), 4)

    def test_floor_over_capacity_uses_source_order_but_output_time_order(self):
        sources = [[self.item(str(i), f'https://example.com/{source}/{i}',
                              f'2026-09-{i + 1:02d}', source) for i in range(4)] for source in ['Z', 'A', 'B']]
        with patch.object(fp, 'MAX_ITEMS_LIST', 5):
            result = fp.merge_items(sources)
        self.assertEqual(len(result), 5)
        self.assertEqual({i['link'] for i in result}, {sources[0][i]['link'] for i in [1, 2, 3]}
                         | {sources[1][i]['link'] for i in [2, 3]})
        self.assertEqual([i['published'] for i in result], sorted((i['published'] for i in result), reverse=True))
