#!/usr/bin/env python3
"""Evaluate production tone questions against external, link-aligned labels."""
import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from back.classify import MAX_CHARS, MAX_ITEMS, MODEL, _http_observer
from back.topics import ToneClient

LABELS = ('negative', 'neutral', 'mixed', 'positive')


class HTTPBudget(Exception):
    pass


def load_data(input_path, gold_path, gold_b_path):
    datasets = []
    for path, gold in ((input_path, False), (gold_path, True), (gold_b_path, True)):
        try:
            rows = json.loads(Path(path).read_text(encoding='utf-8'))
        except (OSError, ValueError):
            raise ValueError('無法讀取外部 JSON；請指定 --input、--gold、--gold-b（資料不隨 repo 提供）') from None
        if not isinstance(rows, list) or not rows:
            raise ValueError('資料必須是非空陣列')
        indexed = {}
        fields = ('link', 'label', 'confidence') if gold else ('link', 'topic_title', 'title', 'summary', 'source')
        for row in rows:
            if (not isinstance(row, dict) or any(not isinstance(row.get(k), str) for k in fields)
                    or not row['link'] or row['link'] in indexed):
                raise ValueError('欄位型別錯誤或 link 重複')
            if gold:
                if row['label'] not in LABELS or row['confidence'] not in ('high', 'low'):
                    raise ValueError('標籤或信心值不合法')
            elif not row['topic_title'] or len(row['title']) + len(row['summary']) > MAX_CHARS:
                raise ValueError('話題為空或單則超過 production 字數上限')
            indexed[row['link']] = row
        datasets.append(indexed)
    items, a, b = datasets
    if set(items) != set(a) or set(items) != set(b):
        raise ValueError('三份資料的 link 集合必須相同')
    return items, a, b


def planned_batches(items):
    """Dry estimate only; requests themselves use production tone_round batching."""
    topics = defaultdict(list)
    for key, row in items.items():
        topics[row['topic_title']].append((key, row['title'], row['summary']))
    count = 0
    for rows in topics.values():
        size = chars = 0
        for _, title, summary in rows:
            length = len(title) + len(summary)
            if size and (size == MAX_ITEMS or chars + length > MAX_CHARS):
                count += 1
                size = chars = 0
            size += 1
            chars += length
        count += bool(size)
    return topics, count


def metric(predictions, gold):
    matrix = {label: {other: 0 for other in LABELS} for label in LABELS}
    correct = flips = scored = 0
    for key, expected in gold.items():
        actual = predictions.get(key)
        if actual not in LABELS:
            continue
        scored += 1
        correct += actual == expected
        flips += {actual, expected} == {'negative', 'positive'}
        matrix[expected][actual] += 1
    return dict(total=len(gold), scored=scored, missing=len(gold)-scored,
                correct=correct, agreement=correct/len(gold) if gold else None,
                polarity_flips=flips, confusion=matrix)


def evaluate(items, a, b, *, client, runs=1, max_http=10):
    topics, batches = planned_batches(items)
    counters = dict(http=0, retries=0)
    def observe(retry):
        if counters['http'] >= max_http:
            raise HTTPBudget()
        counters['http'] += 1
        counters['retries'] += bool(retry)
    token = _http_observer.set(observe)
    results, predictions = [], []
    stopped = False
    try:
        for _ in range(runs):
            pred = {}
            before = counters.copy()
            try:
                for rows in topics.values():
                    for answer in client.tone_round(rows):
                        if (not isinstance(answer, dict) or not set(answer) <= {r[0] for r in rows}
                                or any(value not in LABELS for value in answer.values())):
                            raise ValueError('client 回傳非法評估結果')
                        pred.update(answer)
                    if any(key not in pred for key, _, _ in rows):
                        stopped = True
                        break
            except HTTPBudget:
                stopped = True
            consensus = {key: a[key]['label'] for key in items if a[key]['label'] == b[key]['label']}
            high = {key for key in items if a[key]['confidence'] == b[key]['confidence'] == 'high'}
            groups = {'annotator_a': {k: v['label'] for k, v in a.items()},
                      'annotator_b': {k: v['label'] for k, v in b.items()},
                      'consensus': consensus,
                      'both_high_a': {k: a[k]['label'] for k in high},
                      'both_high_b': {k: b[k]['label'] for k in high},
                      'both_high_consensus': {k: v for k, v in consensus.items() if k in high}}
            results.append(dict(metrics={name: metric(pred, gold) for name, gold in groups.items()},
                                http=counters['http']-before['http'], retries=counters['retries']-before['retries']))
            predictions.append(pred)
            if stopped:
                break
    finally:
        _http_observer.reset(token)
    complete = [k for k in items if len(predictions) == runs and all(k in p for p in predictions)]
    stable = sum(len({p[k] for p in predictions}) == 1 for k in complete)
    return dict(model=MODEL, items=len(items), topics=len(topics), planned_batches_per_run=batches,
                requested_runs=runs, complete=not stopped and len(predictions)==runs,
                runs=results, **counters,
                stability=dict(eligible=len(complete), consistent=stable,
                               agreement=stable/len(complete) if complete else None),
                matrix_axes='rows=gold, columns=model', labels=LABELS)


def positive(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError('必須大於 0')
    return number


def main(argv=None, client_factory=ToneClient):
    parser = argparse.ArgumentParser(description=__doc__)
    for flag, default in (('input', 'tone_gold_input.json'), ('gold', 'tone_gold.json'), ('gold-b', 'tone_gold_b.json')):
        parser.add_argument('--'+flag, default=default)
    parser.add_argument('--runs', type=positive, default=1)
    parser.add_argument('--max-http', type=positive, default=10, help='含重試，所有 runs 共用硬上限（預設 10）')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args(argv)
    try:
        items, a, b = load_data(args.input, args.gold, args.gold_b)
        topics, batches = planned_batches(items)
        if args.dry_run:
            print(json.dumps(dict(items=len(items), topics=len(topics), batches=batches*args.runs, http_limit=args.max_http)))
            return 0
        client = client_factory()
        if not client.enabled:
            print('語氣評估未執行：請設定 TYPESAFE_API_KEY。', file=sys.stderr)
            return 2
        report = evaluate(items, a, b, client=client, runs=args.runs, max_http=args.max_http)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0 if report['complete'] else 1
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
