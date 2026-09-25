"""Pure topic planning and a synchronous, shared-transport jev topic matcher.

plan accepts group_events' key -> event metadata mapping. All membership and
ordering decisions derive from the supplied snapshot; no clocks or I/O.
TopicPair is directional: its left item is always the seed representative.
"""
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta
from hashlib import sha1
import re

if __package__:
    from .classify import _ChoiceClient, _choice, MAX_ITEMS, MAX_CHARS
    from .feedparse import dedup_key
else:
    from classify import _ChoiceClient, _choice, MAX_ITEMS, MAX_CHARS
    from feedparse import dedup_key

MAX_TOPICS = 5
MAX_PENDING = 60
WINDOW = timedelta(hours=48)
CRITERIA = {
    "same_topic": "同一個話題：同一件大事的報導、後續發展、各方反應、評論或影響",
    "different": "不同話題：即使人物或領域相同，講的是另一件事",
}


def words(title):
    title = title.replace("特朗普", "川普").replace("特習", "川習")
    result = {word for word in re.findall(r"[A-Z0-9]{2,}", title.upper()) if not word.isdigit()}
    for run in re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff\U00020000-\U0003134f]+", title):
        for size in (2, 3, 4):
            result.update(run[i:i + size] for i in range(len(run) - size + 1))
    return result


def plan(items, groups, cache, feed_order, previous=()):
    """Retain viable previous seeds before filling slots; sort display separately."""
    records = {dedup_key(item['link']): item for item in items}
    dates = {key: datetime.fromisoformat(item['published']) for key, item in records.items()}
    sources = {name: i for i, name in enumerate(feed_order)}
    order = {key: (dates[key], sources.get(item['source'], len(sources)), key) for key, item in records.items()}
    tokens = {key: words(item['title']) for key, item in records.items()}
    df = Counter(word for terms in tokens.values() for word in terms)
    features = {key: {word for word in terms if df[word] <= len(records) * .1} for key, terms in tokens.items()}
    events = defaultdict(set)
    for key in records:
        events[groups[key]['event']].add(key)
    event_of = {key: event for event, keys in events.items() for key in keys}
    def source_count(keys):
        return len({records[key]['source'] for key in keys})
    seeds = [event for event, keys in events.items() if source_count(keys) >= 3]
    seeds.sort(key=lambda event: (-source_count(events[event]), -max(dates[k].timestamp() for k in events[event]), event))
    seed_candidates = [seed for seed in previous if seed in records]
    seed_candidates.extend(min(events[event], key=order.get) for event in seeds)
    claimed, topics, pending = set(), [], []
    for seed in seed_candidates:
        event = event_of[seed]
        if event in claimed:
            continue
        if len(topics) == MAX_TOPICS:
            break
        members = set(events[event])
        latest = max(dates[key] for key in members)
        while True:
            terms = set().union(*(features[key] for key in members))
            candidates = [key for key in records if key not in members and event_of[key] not in claimed
                          and abs(dates[key] - latest) <= WINDOW and features[key] & terms]
            additions = set()
            for key in candidates:
                if cache.get((seed, key)) is True:
                    additions.update(events[event_of[key]])
            if additions - members:
                members.update(additions)
                continue
            candidates = [key for key in candidates if (seed, key) not in cache]
            candidates.sort(key=lambda key: (-len(features[key] & terms), -dates[key].timestamp(), key))
            unanswered = [(seed, key) for key in candidates[:MAX_PENDING]]
            break
        if source_count(members) < 3:
            continue
        pending.extend(unanswered)
        claimed.update(event_of[key] for key in members)
        topics.append({'id': sha1(seed.encode('utf-8')).hexdigest()[:12], 'title': records[seed]['title'],
                       'sources': source_count(members), 'count': len(members),
                       'keys': sorted(members, key=order.get)})
    topics.sort(key=lambda topic: (-topic['sources'], -topic['count'], topic['id']))
    return topics, pending


@dataclass(frozen=True)
class TopicPair:
    left: tuple
    right: tuple

    @property
    def key(self):
        return self.left[0], self.right[0]


def _state(pairs):
    return [pairs[0].left] + [pair.right for pair in pairs] if pairs else []


def fits(pairs):
    return (not pairs or (len(pairs) < MAX_ITEMS and all(p.left == pairs[0].left for p in pairs)
            and sum(len(t) + len(s) for _, t, s in _state(pairs)) <= MAX_CHARS))


class TopicMatcher(_ChoiceClient):
    _label = 'topics'

    def match(self, pairs):
        pairs = list({pair.key: pair for pair in pairs}.values())
        if not pairs:
            return {}
        if not fits(pairs):
            self.log('topics: batch exceeds limit')
            return None
        return self._request(_state(pairs))

    def match_round(self, pairs):
        started = self.clock()
        batch = []
        for pair in pairs:
            if not self.enabled or self.clock() - started >= self.budget:
                return
            if not fits([pair]):
                self.log('topics: pair exceeds character limit')
                return
            if batch and not fits(batch + [pair]):
                result = self.match(batch)
                if result is None:
                    return
                yield result
                batch = []
                if not self.enabled or self.clock() - started >= self.budget:
                    return
            batch.append(pair)
        if batch and self.enabled and self.clock() - started < self.budget:
            result = self.match(batch)
            if result is not None:
                yield result

    def _questions(self, size):
        return {f't_{i}': {'type': 'choice',
                'instructions': f'news_0 是一個大新聞話題的代表報導。news_{i} 和 news_0 是否屬於同一個新聞話題？',
                'criteria': CRITERIA} for i in range(1, size)}

    def _decode(self, batch, answers):
        result = {}
        for i in range(1, len(batch)):
            choice, probability = _choice(answers.get(f't_{i}'), CRITERIA, 'different')
            result[batch[0][0], batch[i][0]] = choice == 'same_topic' and probability >= .7
        return result


TONE_CRITERIA = {
    'positive': '正面：強調成果、進展、合作或利多',
    'negative': '負面：強調分歧、受挫、風險、抗議或批評',
    'neutral': '中性：主要陳述事實、行程或背景',
    'mixed': '正反並陳',
}


class ToneClient(_ChoiceClient):
    _label = 'tone'

    def tone(self, batch):
        return self._request(batch)

    def tone_round(self, items):
        return self._run_round(items, self.tone)

    def _questions(self, size):
        return {f'q_{i}': {'type': 'choice',
                'instructions': f'news_{i} 對它所報導的事情，整體評價基調是什麼？',
                'criteria': TONE_CRITERIA} for i in range(size)}

    def _decode(self, batch, answers):
        return {key: _choice(answers.get(f'q_{i}'), TONE_CRITERIA, 'neutral')[0]
                for i, (key, _, _) in enumerate(batch)}
