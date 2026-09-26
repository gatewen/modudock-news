#!/usr/bin/env python3
"""Run one real news round over stdio; inherits TYPESAFE_API_KEY if set."""
import argparse
from collections import Counter
import json
import math
import os
import re
from pathlib import Path
import selectors
import subprocess
import sys
import time


def positive_seconds(value):
    value = float(value)
    if not math.isfinite(value) or value <= 0:
        raise argparse.ArgumentTypeError('must be a finite positive number')
    return value


def positive_int(value):
    value = int(value)
    if value <= 0:
        raise argparse.ArgumentTypeError('must be a positive integer')
    return value


def run(args):
    secret = os.environ.get('TYPESAFE_API_KEY', '')

    def safe(text):
        return text.replace(secret, '[REDACTED]') if secret else text

    def say(text):
        print(safe(text), flush=True)

    def quoted(value):
        return json.dumps(value, ensure_ascii=False)

    started = time.monotonic()
    last = first = completed = focus = None
    lists = 0
    outcome = 'timeout'
    stats = []
    source_stats = []
    # A real run must not accidentally inherit test endpoint/feed overrides.
    env = {k: v for k, v in os.environ.items() if not k.startswith('NEWS_TEST_')}
    process = subprocess.Popen([sys.executable, 'back/news.py'], cwd=args.root,
                               env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, bufsize=0)
    selector = selectors.DefaultSelector()
    buffers = {process.stdout: b'', process.stderr: b''}
    for stream in buffers:
        selector.register(stream, selectors.EVENT_READ)

    def send(kind, seq):
        try:
            process.stdin.write((json.dumps({'t': kind, 'seq': seq}) + '\n').encode())
            return True
        except (BrokenPipeError, OSError):
            return False

    def lines(wait):
        for key, _ in selector.select(max(0, wait)):
            stream = key.fileobj
            chunk = os.read(stream.fileno(), 65536)
            if not chunk:
                selector.unregister(stream)
                chunk = b'\n' if buffers[stream] else b''
            data = buffers[stream] + chunk
            parts = data.split(b'\n')
            buffers[stream] = parts.pop()
            # Bound incomplete lines from a broken backend.
            if len(buffers[stream]) > 2 * 1024 * 1024:
                raise ValueError('oversized protocol line')
            for line in parts:
                if stream is process.stderr:
                    text = line.decode('utf-8', errors='replace')
                    if text.startswith("sources round="):
                        source_stats.append(text)
                    if text.startswith('model round='):
                        stats.append(text)
                elif line:
                    yield json.loads(line)

    ready = False
    try:
        send('hello', 1)
        deadline = started + args.timeout
        while time.monotonic() < deadline:
            terminal = False
            for packet in lines(min(.25, deadline - time.monotonic())):
                if packet.get('t') == 'fail':
                    outcome = 'protocol failure'
                    terminal = True
                    break
                if packet.get('t') == 'ready' and not ready:
                    ready = True
                    send('up', 1)  # The protocol requires one seq per session.
                body = packet.get('body', {})
                if packet.get('t') != 'msg' or body.get('op') != 'list':
                    continue
                last = packet
                elapsed = time.monotonic() - started
                lists += 1
                if first is None:
                    first = elapsed
                topics = body.get('topics', {})
                topic_list = topics.get('list', [])
                if focus is None and any(t.get('count', 0) >= args.topic_min for t in topic_list):
                    focus = elapsed
                pending = {name: body.get(name, {}).get('pending')
                           for name in ('classify', 'analysis', 'events', 'topics')}
                pending['tone'] = topics.get('tone_pending')
                state = body.get('model', {}).get('state')
                topic_brief = [{'title': t.get('title'), 'count': t.get('count'),
                                'sources': t.get('sources')} for t in topic_list]
                say(f'{elapsed:6.2f}s list#{lists} items={len(body.get("items", []))} '
                    f'pending={quoted(pending)} model.state={state} topics={quoted(topic_brief)}')
                if state in ('done', 'off'):
                    outcome = state
                    completed = elapsed if state == 'done' else None
                    terminal = True
                    break
            if terminal:
                break
            if not selector.get_map():
                outcome = 'backend exited early'
                break
    except KeyboardInterrupt:
        outcome = 'interrupted'
    except (ValueError, TypeError, AttributeError, OSError):
        # Never dump protocol contents, environment, or arbitrary backend errors.
        outcome = 'invalid protocol or I/O failure'
    finally:
        send('bye', 1)
        process.stdin.close()
        shutdown = time.monotonic() + 3
        try:
            while selector.get_map() and time.monotonic() < shutdown:
                for _ in lines(min(.1, shutdown - time.monotonic())):
                    pass
            process.wait(timeout=max(.001, shutdown - time.monotonic()))
        except (subprocess.TimeoutExpired, ValueError, TypeError, OSError):
            outcome = 'shutdown failure'
            process.kill()
            process.wait()
        finally:
            selector.close()
            process.stdout.close()
            process.stderr.close()

    def seconds(value):
        return '—' if value is None else f'{value:.2f}s'

    say(f'\nresult={outcome} exit={process.returncode} lists={lists}')
    say(f'first_list={seconds(first)} all_done={seconds(completed)} '
        f'first_topic>={args.topic_min}={seconds(focus)}')
    if last is not None:
        body = last['body']
        items = body.get('items', [])
        classified = sum(bool(i.get('category')) for i in items)
        analyzed = sum(isinstance(i.get('analysis'), dict) for i in items)
        events = Counter(i.get('event') or f'missing:{n}' for n, i in enumerate(items))
        say(f'classified={classified}/{len(items)} analyzed={analyzed} '
            f'events={len(events)} multi_report_events={sum(n > 1 for n in events.values())}')
        for topic in body.get('topics', {}).get('list', []):
            say(f'topic {quoted(topic.get("title"))}: {topic.get("count")} 則 / '
                f'{topic.get("sources")} 家 tone={quoted(topic.get("tone", {}))}')
        if args.save:
            # Preserve the complete last list envelope, including partial results.
            args.save.write_text(safe(json.dumps(last, ensure_ascii=False, indent=2)) + '\n', encoding='utf-8')
            say('Last list saved.')
    # Sum completed rounds, never cumulative total_http snapshots. A timeout
    # may lack a completion line; do not claim this is complete process usage.
    measured = [dict(re.findall(r"\b(requests|http|retries)=(\d+)", stat)) for stat in stats]
    say('model_usage (completed rounds): ' + ' '.join(
        f'{name}={sum(int(row[name]) for row in measured)}'
        if all(name in row for row in measured) else f'{name}=unknown'
        for name in ('requests', 'http', 'retries')))
    for stat in source_stats + stats:
        say(stat)
    return 0 if outcome in ('done', 'off') and process.returncode == 0 else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--timeout', type=positive_seconds, default=120, help='total run deadline in seconds (default: 120)')
    parser.add_argument('--topic-min', type=positive_int, default=20, help='report count for first focus timing (default: 20)')
    parser.add_argument('--save', type=Path, metavar='OUT.json', help='save the last list envelope')
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1], help='module directory (default: repository root)')
    args = parser.parse_args()
    try:
        return run(args)
    except OSError:
        print('Unable to start backend or save output; check --root / --save.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
