"""Pure feed parsing: callers supply time/cache and explicitly commit results.

No network, clock reads, or mutation of caller-owned state. Dates without a
timezone are interpreted as UTC. first_seen uses least-recently-used eviction
(SPEC §18.37). Limits use KiB/MiB, as the Outbox does.
"""
from collections import Counter, OrderedDict
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from html import unescape
import json
import re
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit
from xml.parsers import expat

if __package__:
    from .analyze import ANALYSIS_CATEGORIES, QUESTIONS, WORLD_QUESTIONS, POLITICS_QUESTIONS
    from .classify import CRITERIA
else:
    from analyze import ANALYSIS_CATEGORIES, QUESTIONS, WORLD_QUESTIONS, POLITICS_QUESTIONS
    from classify import CRITERIA

LONGEST_CATEGORY = max(CRITERIA, key=len)
CATEGORY_RESERVE = len(json.dumps(LONGEST_CATEGORY)) - len(json.dumps(""))
MAX_ANALYSIS = {name: max(criteria, key=len) for name, (_, criteria, _) in QUESTIONS.items()}
MAX_ANALYSIS["dir_p"] = 0.99
MAX_ANALYSIS["kind"] = "finance"
MAX_WORLD_ANALYSIS = {name: max(criteria, key=len) for name, (_, criteria, _) in WORLD_QUESTIONS.items()}
MAX_WORLD_ANALYSIS["kind"] = "world"
MAX_POLITICS_ANALYSIS = {name: max(criteria, key=len) for name, (_, criteria, _) in POLITICS_QUESTIONS.items()}
MAX_POLITICS_ANALYSIS["kind"] = "politics"
MAX_ANALYSIS = max((MAX_ANALYSIS, MAX_WORLD_ANALYSIS, MAX_POLITICS_ANALYSIS), key=lambda value: len(json.dumps(value)))
ANALYSIS_RESERVE = len(json.dumps(MAX_ANALYSIS)) - len(json.dumps(None))
MAX_ITEMS_LIST = 300
MAX_ITEMS_SOURCE = 60
MAX_PACKET = 900 * 1024
# Titles can contain 300 non-BMP code points (12 ASCII bytes each on wire).
TOPICS_RESERVE = len(json.dumps({'pending': MAX_ITEMS_LIST, 'tone_pending': MAX_ITEMS_LIST, 'list': [
    {'id': 'f' * 12, 'title': '\U0010ffff' * 300, 'sources': MAX_ITEMS_LIST, 'count': MAX_ITEMS_LIST,
     'tone': {tone: MAX_ITEMS_LIST for tone in ('positive', 'negative', 'neutral', 'mixed')}}
    for _ in range(5)]}, ensure_ascii=True))
TOPIC_FIELD_RESERVE = len(', "topic": "' + 'f' * 12 + '"')
TONE_FIELD_RESERVE = len(', "tone": "negative"')
MODEL_RESERVE = len(json.dumps({'state': 'working', 'reason': 'disabled'}))
ATOM = "http://www.w3.org/2005/Atom"


class FeedError(ValueError):
    pass


@dataclass
class Node:
    tag: str
    attrs: dict
    children: list = field(default_factory=list)
    content: list = field(default_factory=list)

    def text(self):
        return "".join(part.text() if isinstance(part, Node) else part for part in self.content)


def _xml(data):
    if not isinstance(data, bytes):
        raise TypeError("feed input must be bytes")
    if len(data) > 2 * 1024 * 1024:
        raise FeedError("feed exceeds 2 MiB")
    parser = expat.ParserCreate(namespace_separator="|")
    stack, root = [], None
    count = text_bytes = 0

    def forbidden(*_args):
        raise FeedError("DTD/entity forbidden")

    def start(tag, attrs):
        nonlocal count, text_bytes, root
        count += 1
        if count > 20000:
            raise FeedError("element limit")
        if len(stack) >= 32:
            raise FeedError("depth limit")
        node = Node(tag, attrs)
        if stack:
            stack[-1].children.append(node)
            stack[-1].content.append(node)
        else:
            root = node
        stack.append(node)
        text_bytes = 0

    def end(_tag):
        nonlocal text_bytes
        stack.pop()
        text_bytes = 0

    def text(value):
        nonlocal text_bytes
        text_bytes += len(value.encode("utf-8"))
        if text_bytes > 256 * 1024:
            raise FeedError("text node limit")
        if stack:
            stack[-1].content.append(value)

    parser.StartDoctypeDeclHandler = forbidden
    parser.EntityDeclHandler = forbidden
    parser.ExternalEntityRefHandler = forbidden
    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.CharacterDataHandler = text
    try:
        parser.Parse(data, True)
    except expat.ExpatError as exc:
        raise FeedError("invalid XML: " + str(exc)) from exc
    if root.tag not in ("rss", "feed", ATOM + "|feed"):
        raise FeedError("unsupported root")
    return root


def _html_text(value):
    """Single forward scan; never retry an unfinished suffix at each '<'.

    Only text and block separators matter here, not attributes or a DOM.
    Entity decoding retains HTMLParser's previous two-pass text behavior.
    """
    parts, i, size = [], 0, len(value)
    while i < size:
        opening = value.find("<", i)
        if opening < 0:
            parts.append(unescape(value[i:]))
            break
        parts.append(unescape(value[i:opening]))
        i = opening
        if value.startswith("<!--", i):
            end = re.compile(r"--\s*>").search(value, i + 4)
            if end is None:
                parts.append(unescape(value[i:]))
                break
            i = end.end()
            continue
        if value.startswith("<![", i):
            # HTML marked sections (including Word conditional declarations).
            terminator = "]]>" if value.startswith("<![CDATA[", i) else "]>"
            end = value.find(terminator, i + 3)
            if end < 0:
                parts.append(unescape(value[i:]))
                break
            i = end + len(terminator)
            continue
        closing = value.startswith("</", i)
        name_start = i + (2 if closing else 1)
        if closing:
            while name_start < size and value[name_start].isspace():
                name_start += 1
        declaration = value.startswith(("<!", "<?"), i)
        if not declaration and (name_start == size or not value[name_start].isascii()
                                or not value[name_start].isalpha()):
            parts.append("<")
            i += 1
            continue
        end_name = name_start
        while end_name < size and value[end_name] not in " \t\n\r\f/>\x00":
            end_name += 1
        name = value[name_start:end_name].lower()
        end, quote, state = end_name, None, "attribute"
        first_gt = -1
        while end < size:
            char = value[end]
            if char == ">" and first_gt < 0:
                first_gt = end
            if quote:
                if char == quote:
                    quote, state = None, "attribute"
            elif char == ">":
                break
            elif state == "bare":
                if char.isspace():
                    state = "attribute"
            elif state == "value":
                if char in "\"'":
                    quote = char
                elif not char.isspace() and char != "=":
                    state = "bare"
            elif char == "=":
                state = "value"
            end += 1
        if end == size:
            if first_gt >= 0:
                # Unclosed quoted attribute: preserve only this broken fragment,
                # then continue parsing the remaining markup like HTMLParser.
                parts.append(unescape(value[i:first_gt + 1]))
                i = first_gt + 1
                continue
            # An unfinished markup suffix cannot invalidate preceding text.
            # Keep literal comparisons such as x<y; discard cut attribute tails.
            if (end_name == size and not closing) or declaration:
                parts.append(unescape(value[i:]))
            break
        if "\x00" in value[i:end]:
            parts.append(unescape(value[i:end + 1]))
            i = end + 1
            continue
        if not declaration and (name in ("p", "div", "li") or (name == "br" and not closing)):
            parts.append(" ")
        self_closing = value[i:end].rstrip().endswith("/")
        i = end + 1
        if not declaration and not closing and not self_closing and name in ("script", "style"):
            finish = re.compile(r"</\s*" + name + r"\s*>", re.I).search(value, i)
            if finish is None:
                break  # Same as HTMLParser's unclosed raw-text element.
            parts.append(value[i:finish.start()])
            i = finish.end()
    return unescape("".join(parts))


def plain(value, limit):
    value = value[:8192]
    text = _html_text(value)
    return " ".join(text.split())[:limit]


def _iso(value):
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _date(value):
    for parse in (parsedate_to_datetime, datetime.fromisoformat):
        try:
            return _iso(parse(value))
        except (ValueError, TypeError, OverflowError):
            pass
    return None


def dedup_key(link):
    parts = urlsplit(link)
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
             if not k.startswith("utm_") and k != "fbclid"]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), ""))


_MATCH_IGNORED = str.maketrans('', '', '\u200b\u200c\u2060\ufeff')


def match_text(value):
    """Remove invisible separators for matching only; preserve ZWJ and display text."""
    return value.translate(_MATCH_IGNORED)


def parse_feed(data, final_url, source, first_seen, now):
    """Return (normalized items, candidate first_seen), never commit cache.

    source is the configured name (1..64 chars); now is a datetime supplied by
    the coordinator. Empty preferred fields use their documented fallback.
    An invalid but nonempty preferred date falls back to first_seen, not updated.
    """
    if not isinstance(source, str) or not source.strip() or len(source) > 64:
        raise ValueError("source must contain 1..64 characters")
    timestamp = _iso(now)
    current = datetime.fromisoformat(timestamp)
    root = _xml(data)
    seen = OrderedDict(first_seen)
    atom = root.tag != "rss"
    prefix = ATOM + "|" if root.tag == ATOM + "|feed" else ""

    def children(node, name):
        return [child for child in node.children if child.tag == prefix + name]

    def first(node, name):
        found = children(node, name)
        return found[0].text().strip() if found else ""

    entries = children(root, "entry") if atom else [
        item for channel in children(root, "channel") for item in children(channel, "item")]
    items = []
    for entry in entries:
        title = plain(first(entry, "title"), 300)
        if not title:
            continue
        if atom:
            links = [link for link in children(entry, "link") if link.attrs.get("href", "").strip()]
            preferred = [link for link in links if link.attrs.get("rel", "alternate") == "alternate"]
            link = (preferred or links)[0].attrs.get("href", "").strip() if links else ""
        else:
            link = first(entry, "link")
            guids = children(entry, "guid")
            if not link and guids and guids[0].attrs.get("isPermaLink") != "false":
                link = guids[0].text().strip()
        if not link:
            continue
        try:
            link = urljoin(final_url, link)
            parsed = urlsplit(link)
            if parsed.scheme not in ("http", "https") or not parsed.hostname or len(link) > 2048:
                continue
            _ = parsed.port
            key = dedup_key(link)
        except ValueError:
            continue
        date = first(entry, "published" if atom else "pubDate") or first(entry, "updated")
        published = _date(date)
        if published is not None and datetime.fromisoformat(published) - current > timedelta(minutes=10):
            published = None
        guessed = published is None
        if guessed:
            if key not in seen:
                seen[key] = timestamp
            published = seen[key]
        if key in seen:
            seen.move_to_end(key)
        summary = (first(entry, "summary") or first(entry, "content")) if atom else first(entry, "description")
        items.append(dict(title=title, link=link, published=published,
                          summary=plain(summary, 200), source=source, time_guessed=guessed))
    # Finish every lookup before LRU eviction, so inserting a missing key
    # cannot evict another entry that this same feed has yet to visit.
    while len(seen) > 1000:
        seen.popitem(last=False)
    return items, seen


def merge_items(source_items, feeds=()):
    """Trusted publisher domain, then configured order, owns cross-source keys.

    Dates choose versions within one source only. Domains come from local feed
    configuration, never from feed contents or redirect destinations.
    """
    winners = {}
    source_order = {feed["name"]: i for i, feed in enumerate(feeds)}
    domains = {}
    for feed in feeds:
        host = urlsplit(feed["url"]).hostname or ""
        domains[feed["name"]] = feed.get("link_domains", [host.removeprefix("www.")])

    def priority(item):
        host = (urlsplit(item["link"]).hostname or "").lower().rstrip(".")
        owned = any(host == domain or host.endswith("." + domain)
                    for domain in domains.get(item["source"], ()) if domain)
        return owned, -source_order[item["source"]]

    for items in source_items:
        for item in items:
            source_order.setdefault(item["source"], len(source_order))
            key = dedup_key(item["link"])
            previous = winners.get(key)
            if (previous is None
                    or (item["source"] == previous["source"] and item["published"] > previous["published"])
                    or (item["source"] != previous["source"] and priority(item) > priority(previous))):
                winners[key] = item
    result = sorted(winners.values(), key=lambda item: (item["source"], item["title"]))
    result.sort(key=lambda item: item["published"], reverse=True)
    by_source = {source: [] for source in source_order}
    for item in result:
        reserved = by_source[item["source"]]
        if len(reserved) < 3:
            reserved.append(dedup_key(item["link"]))
    selected = set()
    counts = Counter()
    for keys in by_source.values():
        for key in keys:
            if len(selected) < MAX_ITEMS_LIST:
                selected.add(key)
                counts[winners[key]["source"]] += 1
    for item in result:
        if len(selected) >= MAX_ITEMS_LIST:
            break
        key = dedup_key(item["link"])
        if key not in selected and counts[item["source"]] < MAX_ITEMS_SOURCE:
            selected.add(key)
            counts[item["source"]] += 1
    return deepcopy([item for item in result if dedup_key(item["link"]) in selected])


def packet_bytes(packet):
    return (json.dumps(packet, ensure_ascii=True, allow_nan=False) + "\n").encode("ascii")


def fit_packet(packet):
    """Copy a full list envelope, trim the tail, recount sources/count if present.

    Unfilled category/analysis fields reserve their maximum future byte lengths.
    Returns a packet, not bytes. An oversized envelope even with zero items is
    an error, never an oversized success. publish count must use returned items.
    """
    result = deepcopy(packet)
    body = result["body"]
    items = body["items"]
    while True:
        for source in body.get("sources", []):
            source["count"] = sum(item["source"] == source["name"] for item in items)
        if "classify" in body:
            body["classify"]["pending"] = (sum(item.get("category", "") == "" for item in items)
                                             if body["classify"]["enabled"] else 0)
        if "analysis" in body:
            body["analysis"]["pending"] = (sum(item.get("category") in ANALYSIS_CATEGORIES
                and item.get("analysis") is None for item in items)
                if body.get("classify", {}).get("enabled", False) else 0)
        event_sizes = Counter(item["event"] for item in items if "event" in item)
        for item in items:
            if "event" in item:
                item["event_size"] = event_sizes[item["event"]]
        if "count" in body:
            body["count"] = len(items)
        reserved = sum(CATEGORY_RESERVE for item in items if item.get("category") == "")
        if 'model' in body:
            reserved += max(0, MODEL_RESERVE - len(json.dumps(body['model'])))
        reserved += sum(ANALYSIS_RESERVE for item in items
                        if "analysis" in item and item["analysis"] is None
                        and item.get("category") in ANALYSIS_CATEGORIES | {""})
        reserved += sum(3 - len(str(item["event_size"])) for item in items if "event_size" in item)
        if 'topics' in body:
            reserved += max(0, TOPICS_RESERVE - len(json.dumps(body['topics'], ensure_ascii=True)))
            reserved += sum(TOPIC_FIELD_RESERVE for item in items if 'topic' not in item)
            reserved += sum(TONE_FIELD_RESERVE if 'tone' not in item else
                            max(0, len('negative') - len(item['tone'])) for item in items)
        if len(packet_bytes(result)) + reserved <= MAX_PACKET:
            return result
        if not items:
            raise ValueError("envelope exceeds 900 KiB without items")
        items.pop()
