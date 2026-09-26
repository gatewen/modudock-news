"""R6 local malformed HTML recovery and bounded parsing compatibility."""
import unittest
from back.feedparse import plain
from tests.test_feed_security import legacy_plain

cases = {
 "unquoted_apostrophe": "<a title=Tom's>Hello</a> world",
 "unquoted_apostrophe_2": "<img alt=don't src=x.jpg>Tom's book is here",
 "truncated_tag": ("<p>" + "字" * 8180 + "</p><img src=\"https://x/y.jpg\">"),
 "trunc_in_tag_summary": ("<p>首段新聞內容。</p>" + "<p>" + "a" * 50 + "</p>") * 150,
 "pi_quote": "<?xml version='1.0'?>Hi",
 "bogus_decl": "<!x>Hi",
 "end_space": "a</ b>c",
 "lt_space": "1 < 2 > 0",
 "abrupt_comment": "a<!-->b",
 "comment_bang": "a<!-- x --!>b",
 "script": "<script>var a='</p>';</script>after",
 "script_unclosed": "x<script>var a",
 "cdata": "a<![CDATA[x<y]]>b",
 "cdata_gt": "a<![CDATA[x]>y]]>b",
 "cond": "a<![if !IE]>b<![endif]>c",
 "entity_split": "&amp;lt;b&amp;gt;",
 "nul_name": "a<p\x00>b",
 "slash_tag": "a<p/>b",
 "br_close": "a</br>b",
 "attr_gt": '<a title="x>y">T</a>',
 "unclosed_attr_quote": '<a title="x>T</a> tail',
 "lone_lt_end": "abc <",
 "lt_bang_end": "abc <!",
 "doctype": "<!DOCTYPE html>x",
 "textarea": "<textarea><b>x</b></textarea>y",
 "title": "<title><b>x</b></title>y",
 "style_upper": "<STYLE>p{}</STYLE>z",
 "noscript": "<noscript><p>x</p></noscript>",
 "entity_nosemi": "AT&T &copy 2024",
 "trailing_amp": "a &#",
}

class PlainCompatibilityTests(unittest.TestCase):
    def test_review_cases_match_htmlparser(self):
        for name, value in cases.items():
            with self.subTest(name=name):
                self.assertEqual(plain(value,200),legacy_plain(value,200))

    def test_four_hundred_realistic_html_cut_offsets(self):
        para = ('<p>行政院今天召開會議，討論下一年度預算與相關配套措施，多位官員出席說明。</p>'
                '<figure><img src="https://example.com/images/2026/09/26/photo-{n}.jpg" alt="示意圖" width="800" height="600">'
                '<figcaption>圖說：會議現場</figcaption></figure>'
                '<p>更多內容請見<a href="https://example.com/news/{n}?from=rss">原文連結</a>。</p>')
        for pad in range(400):
            value='x'*pad+''.join(para.replace('{n}',str(n)) for n in range(40))
            with self.subTest(pad=pad):
                self.assertEqual(plain(value,200),legacy_plain(value,200))

    def test_malformed_suffix_does_not_turn_good_prefix_into_markup(self):
        self.assertEqual(plain('<b>前文</b> x<y',200),'前文 x<y')
        self.assertEqual(plain('<p>前文</p><a href="cut',200),'前文')
        self.assertEqual(plain('<p>前文</p',200),'前文')
        self.assertEqual(plain('<p>前文</p><![unknown]>尾',200),'前文 尾')
        self.assertEqual(plain('<p>前文</p><!['*2,200),'前文 <![<p>前文</p><![')
