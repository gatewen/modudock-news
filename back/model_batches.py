"""Pure packing decisions over one round's already-queued prefix.

The caller owns locking, round boundaries, queue mutation and acknowledgements.
No input is mutated; dropped topic pairs still require coordinator completion.
"""
from dataclasses import dataclass

if __package__:
    from .classify import MAX_ITEMS
    from .analyze import analysis_kind
    from .events import pack_batch
else:
    from classify import MAX_ITEMS
    from analyze import analysis_kind
    from events import pack_batch


@dataclass
class BatchPlan:
    batch: list
    remaining: list
    dropped: list
    kind: str | None = None


def plan_batch(lane_name, first, pending, *, fits, categories=None, eligible=None):
    """pending excludes first and contains only the same ModelRound's prefix."""
    remaining = list(pending)
    batch, dropped, kind = [first], [], None
    if lane_name == 'events':
        batch, remaining = pack_batch([first, *remaining])
    elif lane_name == 'topics':
        eligible = eligible or {}
        if first.right[0] not in eligible.get(first.left[0], ()):
            dropped.append(first)
            batch = []
        index = 0
        while index < len(remaining):
            pair = remaining[index]
            if pair.right[0] not in eligible.get(pair.left[0], ()):
                dropped.append(remaining.pop(index))
            elif fits(batch + [pair]):
                batch.append(remaining.pop(index))
            else:
                index += 1
    elif lane_name == 'analysis':
        categories = categories or {}
        kind = analysis_kind(categories.get(first[0], ''))
        index = 0
        while index < len(remaining) and len(batch) < MAX_ITEMS:
            item = remaining[index]
            if analysis_kind(categories.get(item[0], '')) != kind:
                index += 1
                continue
            if not fits(batch + [item]):
                break
            batch.append(remaining.pop(index))
    elif lane_name == 'tone' and eligible is not None:
        candidates = [first, *remaining]
        dropped = [item for item in candidates if item not in eligible]
        candidates = [item for item in candidates if item in eligible]
        if not candidates:
            return BatchPlan([], [], dropped)
        packed = plan_batch('tone', candidates[0], candidates[1:], fits=fits)
        return BatchPlan(packed.batch, packed.remaining, dropped)
    elif lane_name in ('classify', 'tone'):
        while remaining and len(batch) < MAX_ITEMS:
            if not fits(batch + [remaining[0]]):
                break
            batch.append(remaining.pop(0))
    else:
        raise ValueError('unknown model lane')
    return BatchPlan(batch, remaining, dropped, kind)
