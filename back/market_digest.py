"""Bounded, article-free market broadcast built from the emitted list.

Finance scope and representative analysis match front/scope.js + panel.js.
The 24h event window is applied before aggregation, without UI filters.
"""
from collections import defaultdict
from datetime import datetime, timedelta
import json
import re

if __package__:
    from .analyze import valid_analysis
else:
    from analyze import valid_analysis

TOPIC = 'news.market_digest'
MAX_BYTES = 8192
WINDOW_HOURS = 24
# Same names and tie order as front/labels.js; cross-language parity is tested.
THEME_NAMES = dict([
    ('foundry', '晶圓代工'), ('ic_design', 'IC 設計'), ('memory', '記憶體'),
    ('packaging', '先進封裝'), ('semi_equip', '半導體設備材料'), ('ai_server', 'AI 伺服器'),
    ('cooling', '散熱'), ('pcb', 'PCB／被動元件'), ('optical', '光通訊'),
    ('display', '光電面板'), ('leo', '低軌衛星'), ('energy', '能源'),
    ('ev', '電動車'), ('financials', '金融'), ('property', '營建房產'),
    ('transport', '航運航空'), ('consumer_elec', '消費電子'), ('petrochem', '原物料傳產'),
    ('software', '軟體網路'), ('industrial', '工業電腦'),
    ('biotech', '生技醫療'), ('retail', '零售通路'), ('macro', '大盤／總經'), ('other', '其他'),
])
SIGNALS = {'positive': 'bullish', 'mixed': 'mixed', 'not_market': 'unrelated',
           'other': 'unrelated', 'negative': 'bearish'}


def compact(value):
    # ASCII escaping is also the actual backend wire encoding, so this bounds
    # both the transmitted body and the receiver's UTF-8 canonical form.
    return json.dumps(value, ensure_ascii=True, separators=(',', ':'), allow_nan=False).encode('ascii')


def fit_digest(body, max_bytes=MAX_BYTES):
    body = {**body, 'top_themes': list(body['top_themes'])}
    while len(compact(body)) > max_bytes:
        if not body['top_themes']:
            return None
        body['top_themes'].pop()
    return body


def _date(value):
    try:
        stamp = datetime.fromisoformat(value)
        return stamp if stamp.utcoffset() is not None else None
    except (TypeError, ValueError):
        return None


def build_digest(items, feeds, now):
    """Return schema-1 body, or None if no windowed event has valid analysis."""
    if not isinstance(now, datetime) or now.utcoffset() is None:
        raise ValueError('digest requires aware local publication time')
    start = now - timedelta(hours=WINDOW_HOURS)
    order = {f['name']: index for index, f in enumerate(feeds)}
    outlets = {f['name']: f.get('outlet', f['name']) for f in feeds}
    groups = defaultdict(list)
    for index, item in enumerate(items):
        if item.get('category') != 'finance':
            continue
        stamp = _date(item.get('published'))
        if stamp is None:
            continue
        event = item.get('event')
        valid_event = (isinstance(event, str) and re.fullmatch('[0-9a-fA-F]{12}', event)
                       and type(item.get('event_size')) is int and item['event_size'] > 0)
        groups[('event', event.lower()) if valid_event else ('item', index)].append((stamp, index, item))
    signals = dict.fromkeys(('bullish', 'mixed', 'unrelated', 'bearish'), 0)
    themes = {key: [0, 0, 0] for key in THEME_NAMES}
    sources = set()
    for reports in groups.values():
        latest = max(row[0] for row in reports)
        if not start <= latest <= now:
            continue
        # JS Date.parse groups timestamps at millisecond precision.
        reports.sort(key=lambda row: (int(row[0].timestamp() * 1000),
                                      order.get(row[2].get('source'), len(feeds)), row[1]))
        sources.update(outlets.get(row[2]['source'], row[2]['source']) for row in reports
                       if isinstance(row[2].get('source'), str) and row[2]['source'])
        analysis = next((row[2].get('analysis') for row in reports
                         if valid_analysis(row[2].get('analysis'))
                         and row[2]['analysis'].get('kind', 'finance') == 'finance'), None)
        if analysis is None:
            continue
        signals[SIGNALS[analysis['market']]] += 1
        counts = themes[analysis['theme']]
        counts[0] += 1
        if analysis['dir_p'] >= .6:
            counts[1] += analysis['dir'] == 'bull'
            counts[2] += analysis['dir'] == 'bear'
    if not sum(signals.values()):
        return None
    ranked = sorted((key for key, counts in themes.items()
                     if key not in ('macro', 'other') and counts[0]), key=lambda key: -themes[key][0])[:10]
    top = []
    for key in ranked:
        count, bull, bear = themes[key]
        direction = 'mixed' if bull and bear else 'bullish' if bull else 'bearish' if bear else 'unrelated'
        top.append(dict(name=THEME_NAMES[key], events=count, direction=direction))
    return fit_digest(dict(schema=1, at=now.isoformat(timespec='microseconds'), window_hours=WINDOW_HOURS,
                           signal_counts=signals, top_themes=top, source_count=len(sources)))
