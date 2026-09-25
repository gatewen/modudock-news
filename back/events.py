"""Same-event candidates, synchronous jev matching, and deterministic grouping.

candidate_pairs/group_events take normalized feed items. EventMatcher takes
Pair objects and returns frozenset({dedup_key_a, dedup_key_b}) -> bool (or None
for a failed batch). match_round yields complete batches, including automatic
matches even when the API is disabled. Threads and caches belong to the caller.
Like the other choice clients, use a matcher on only one worker at a time.
"""
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta
from hashlib import sha1
from itertools import combinations
import unicodedata

if __package__:
    from .classify import _ChoiceClient, _choice, MAX_ITEMS, MAX_CHARS
    from .feedparse import dedup_key
else:
    from classify import _ChoiceClient, _choice, MAX_ITEMS, MAX_CHARS
    from feedparse import dedup_key

CRITERIA = {
    "same": "是同一個事件",
    "related": "主題相關但不是同一個事件",
    "different": "不同事件",
}
CANDIDATE_THRESHOLD = 0.2
AUTO_THRESHOLD = 0.9
SAME_THRESHOLD = 0.8
MAX_QUESTIONS = 40
CANDIDATE_WINDOW = timedelta(hours=36)
GROUP_WINDOW = timedelta(hours=24)


def _bigrams(title):
    clean = "".join(c for c in title.lower()
                    if not c.isspace() and not unicodedata.category(c).startswith("P"))
    return set(zip(clean, clean[1:]))


def _overlap(left, right):
    return len(left & right) / min(len(left), len(right)) if left and right else 0.0


def title_overlap(left, right):
    """Set bigram overlap coefficient; titles with no bigrams score zero."""
    return _overlap(_bigrams(left), _bigrams(right))


@dataclass(frozen=True)
class Pair:
    left: tuple  # (dedup_key, title, summary)
    right: tuple
    similarity: float

    @property
    def key(self):
        return frozenset((self.left[0], self.right[0]))

    @property
    def automatic(self):
        return self.similarity >= AUTO_THRESHOLD


def candidate_pairs(items):
    """Generate each unordered pair once, in input order, across all categories."""
    records = {}
    for item in items:
        key = dedup_key(item["link"])
        records.setdefault(key, ((key, item["title"], item["summary"]),
                                 datetime.fromisoformat(item["published"]), _bigrams(item["title"])))
    result = []
    for (left, left_time, left_grams), (right, right_time, right_grams) in combinations(records.values(), 2):
        if abs(left_time - right_time) > CANDIDATE_WINDOW:
            continue
        score = _overlap(left_grams, right_grams)
        if score >= CANDIDATE_THRESHOLD:
            result.append(Pair(left, right, score))
    return result


def _state(pairs):
    state = {}
    for pair in pairs:
        for item in (pair.left, pair.right):
            state.setdefault(item[0], item)
    return list(state.values())


def _fits(pairs):
    state = _state(pairs)
    return (len(pairs) <= MAX_QUESTIONS and len(state) <= MAX_ITEMS
            and sum(len(title) + len(summary) for _, title, summary in state) <= MAX_CHARS)


class EventMatcher(_ChoiceClient):
    _label = "events"

    def match(self, pairs):
        """One atomic batch; automatic pairs never enter state or questions."""
        pairs = list({pair.key: pair for pair in pairs}.values())
        automatic = {pair.key: True for pair in pairs if pair.automatic}
        pending = [pair for pair in pairs if not pair.automatic]
        if not pending:
            return automatic
        if not _fits(pending):
            self.log("events: batch exceeds limit")
            return None
        result = self._request(_state(pending), context=pending)
        return None if result is None else automatic | result

    def match_round(self, pairs):
        """Greedy batching with unique-state limits and a 60s admission budget."""
        started = self.clock()
        pairs = list({pair.key: pair for pair in pairs}.values())
        automatic = {pair.key: True for pair in pairs if pair.automatic}
        if automatic:
            yield automatic
        batch = []
        for pair in pairs:
            if pair.automatic:
                continue
            if not self.enabled or self.clock() - started >= self.budget:
                return
            if not _fits([pair]):
                self.log("events: pair exceeds character limit")
                return
            if batch and not _fits(batch + [pair]):
                result = self.match(batch)
                if result is None:
                    return
                yield result
                if not self.enabled or self.clock() - started >= self.budget:
                    return
                batch = []
            batch.append(pair)
        if batch and self.enabled and self.clock() - started < self.budget:
            result = self.match(batch)
            if result is not None:
                yield result

    def _questions(self, size, context=None):
        indices = {item[0]: i for i, item in enumerate(_state(context))}
        return {f"same_{i}": {
            "type": "choice",
            "instructions": f"news_{indices[pair.left[0]]} 與 news_{indices[pair.right[0]]} 是否在報導同一個事件（同一件事、同一個發布或同一段行情）？",
            "criteria": CRITERIA,
        } for i, pair in enumerate(context)}

    def _decode(self, batch, answers, context=None):
        result = {}
        for i, pair in enumerate(context):
            choice, p_max = _choice(answers.get(f"same_{i}"), CRITERIA, "different")
            result[pair.key] = choice == "same" and p_max >= SAME_THRESHOLD
        return result


def group_events(items, matches, feed_order):
    """Return key -> {event, event_size}, without changing items or matches.

    feed_order is a sequence of source names in feeds.json order. Unknown
    sources sort last; dedup_key breaks any remaining tie. Edges are processed
    by endpoint representative order, so arrival/input order cannot affect a
    24-hour partition. A merge checks the *whole* combined span, including
    when joining two existing groups; rejected edges do not alter the cache.
    """
    sources = {name: i for i, name in enumerate(feed_order)}
    records = {dedup_key(item["link"]): item for item in items}
    dates = {key: datetime.fromisoformat(item["published"]) for key, item in records.items()}
    order = {key: (dates[key], sources.get(item["source"], len(sources)), key)
             for key, item in records.items()}
    parent = {key: key for key in records}
    latest = dict(dates)

    def find(key):
        while parent[key] != key:
            parent[key] = parent[parent[key]]
            key = parent[key]
        return key

    edges = [tuple(sorted(pair, key=order.get)) for pair, same in matches.items()
             if same is True and len(pair) == 2 and all(key in records for key in pair)]
    edges.sort(key=lambda edge: (order[edge[0]], order[edge[1]]))
    for left, right in edges:
        left, right = sorted((find(left), find(right)), key=order.get)
        if left == right:
            continue
        end = max(latest[left], latest[right])
        if end - dates[left] > GROUP_WINDOW:
            continue
        parent[right] = left
        latest[left] = end
    roots = {key: find(key) for key in records}
    sizes = Counter(roots.values())
    return {key: {"event": sha1(root.encode("utf-8")).hexdigest()[:12], "event_size": sizes[root]}
            for key, root in roots.items()}
