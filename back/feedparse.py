"""Pure feed parsing: callers supply time/cache and explicitly commit results.

No network, clock reads, or mutation of caller-owned state. Dates without a
timezone are interpreted as UTC. first_seen uses oldest-insertion eviction
(SPEC §5.5), not access-order eviction. Limits use KiB/MiB, as the Outbox does.
"""
from collections import Counter, OrderedDict
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html import unescape
from html.parser import HTMLParser
import json
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit
from xml.parsers import expat

if __package__:
    from .analyze import ANALYSIS_CATEGORIES, QUESTIONS, WORLD_QUESTIONS
    from .classify import CRITERIA
else:
    from analyze import ANALYSIS_CATEGORIES, QUESTIONS, WORLD_QUESTIONS
    from classify import CRITERIA

LONGEST_CATEGORY = max(CRITERIA, key=len)
CATEGORY_RESERVE = len(json.dumps(LONGEST_CATEGORY)) - len(json.dumps(""))
MAX_ANALYSIS = {name: max(criteria, key=len) for name, (_, criteria, _) in QUESTIONS.items()}
MAX_ANALYSIS["dir_p"] = 0.99
MAX_ANALYSIS["kind"] = "finance"
MAX_WORLD_ANALYSIS = {name: max(criteria, key=len) for name, (_, criteria, _) in WORLD_QUESTIONS.items()}
MAX_WORLD_ANALYSIS["kind"] = "world"
MAX_ANALYSIS = max((MAX_ANALYSIS, MAX_WORLD_ANALYSIS), key=lambda value: len(json.dumps(value)))
ANALYSIS_RESERVE = len(json.dumps(MAX_ANALYSIS)) - len(json.dumps(None))
MAX_ITEMS_LIST = 300
MAX_PACKET = 900 * 1024
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


class _Plain(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)

    def handle_starttag(self, tag, attrs):
        if tag in ("br", "p", "div", "li"):
            self.parts.append(" ")

    def handle_endtag(self, tag):
        if tag in ("p", "div", "li"):
            self.parts.append(" ")


def plain(value, limit):
    parser = _Plain()
    parser.feed(value)
    parser.close()
    return " ".join(unescape("".join(parser.parts)).split())[:limit]


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


def parse_feed(data, final_url, source, first_seen, now):
    """Return (normalized items, candidate first_seen), never commit cache.

    source is the configured name (1..64 chars); now is a datetime supplied by
    the coordinator. Empty preferred fields use their documented fallback.
    An invalid but nonempty preferred date falls back to first_seen, not updated.
    """
    if not isinstance(source, str) or not source.strip() or len(source) > 64:
        raise ValueError("source must contain 1..64 characters")
    timestamp = _iso(now)
    root = _xml(data)
    seen = OrderedDict(first_seen)
    while len(seen) > 1000:
        seen.popitem(last=False)
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
        guessed = published is None
        if guessed:
            if key not in seen:
                seen[key] = timestamp
                if len(seen) > 1000:
                    seen.popitem(last=False)
            published = seen[key]
        summary = (first(entry, "summary") or first(entry, "content")) if atom else first(entry, "description")
        items.append(dict(title=title, link=link, published=published,
                          summary=plain(summary, 200), source=source, time_guessed=guessed))
    return items, seen


def merge_items(source_items):
    """Lists in feeds.json order. Equal date/key retains first encountered item."""
    winners = {}
    source_order = {}
    for items in source_items:
        for item in items:
            source_order.setdefault(item["source"], None)
            key = dedup_key(item["link"])
            if key not in winners or item["published"] > winners[key]["published"]:
                winners[key] = item
    result = sorted(winners.values(), key=lambda item: (item["source"], item["title"]))
    result.sort(key=lambda item: item["published"], reverse=True)
    by_source = {source: [] for source in source_order}
    for item in result:
        reserved = by_source[item["source"]]
        if len(reserved) < 3:
            reserved.append(dedup_key(item["link"]))
    selected = set()
    for keys in by_source.values():
        for key in keys:
            if len(selected) < MAX_ITEMS_LIST:
                selected.add(key)
    for item in result:
        if len(selected) >= MAX_ITEMS_LIST:
            break
        selected.add(dedup_key(item["link"]))
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
        reserved += sum(ANALYSIS_RESERVE for item in items
                        if "analysis" in item and item["analysis"] is None
                        and item.get("category") in ANALYSIS_CATEGORIES | {""})
        reserved += sum(3 - len(str(item["event_size"])) for item in items if "event_size" in item)
        if len(packet_bytes(result)) + reserved <= MAX_PACKET:
            return result
        if not items:
            raise ValueError("envelope exceeds 900 KiB without items")
        items.pop()
