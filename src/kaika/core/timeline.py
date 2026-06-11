"""Timeline directives: authored, time-anchored events on top of the score.

Anchors (``section:drop+4.0``, ``beat:32``, ``bar:8``) are resolved against the
score at simulate/preview time, never baked — editing sections re-binds them on
the next preview. An anchor that does not bind never fails the render: the
directive is skipped and a warning is recorded (surfaced in the run manifest,
the UI, and the chat copilot's context). A ``section:`` anchor matching several
sections fires once per match.
"""
from __future__ import annotations

import re
from typing import List, Optional, Tuple

from .score import Score

_ANCHOR_RE = re.compile(r"^(section|beat|bar):([^+\-]+)([+\-][0-9.]+)?$")


def resolve_anchor(value, score: Score) -> Tuple[List[float], Optional[str]]:
    """Resolve an ``at``/``between`` element to absolute seconds.

    Returns (times, warning): plain numbers give one time; ``section:`` anchors
    may give several (one per matching section); an unbound anchor gives
    ([], reason)."""
    if isinstance(value, (int, float)):
        return [float(value)], None
    s = str(value).strip()
    m = _ANCHOR_RE.match(s)
    if not m:
        try:
            return [float(s)], None
        except ValueError:
            return [], f"unparseable anchor '{value}'"
    kind, ref, off = m.group(1), m.group(2).strip(), float(m.group(3) or 0.0)
    if kind == "section":
        hits = [sec.start + off for sec in score.sections if sec.label == ref]
        if not hits:
            return [], (f"anchor '{value}': no section labelled '{ref}' "
                        f"(have: {sorted({x.label for x in score.sections})})")
        return hits, None
    try:
        idx = int(float(ref))
    except ValueError:
        return [], f"anchor '{value}': index '{ref}' is not a number"
    beats = score.beats
    beat_idx = idx * 4 if kind == "bar" else idx
    if beat_idx < 0 or beat_idx >= len(beats):
        return [], (f"anchor '{value}': {kind} {idx} is out of range "
                    f"(track has {len(beats)} beats)")
    return [beats[beat_idx].t + off], None


def resolve_directives(timeline: List[dict], score: Score
                       ) -> Tuple[List[dict], List[str]]:
    """Expand a timeline into directives with absolute times.

    spawn/mute/unmute get ``t``; set windows get ``t0``/``t1``. Unbound
    directives are skipped with a warning string."""
    resolved: List[dict] = []
    warnings: List[str] = []
    for i, d in enumerate(timeline or []):
        action = d.get("action", "spawn")
        if action == "set" or "between" in d:
            pair = d.get("between") or []
            if len(pair) != 2:
                warnings.append(f"timeline[{i}]: 'between' needs [t0, t1] — skipped")
                continue
            t0s, w0 = resolve_anchor(pair[0], score)
            t1s, w1 = resolve_anchor(pair[1], score)
            for w in (w0, w1):
                if w:
                    warnings.append(f"timeline[{i}]: {w} — skipped")
            if not t0s or not t1s:
                continue
            resolved.append({**d, "action": action, "t0": min(t0s[0], t1s[0]),
                             "t1": max(t0s[0], t1s[0])})
        else:
            times, w = resolve_anchor(d.get("at", 0.0), score)
            if w:
                warnings.append(f"timeline[{i}]: {w} — skipped")
                continue
            for t in times:
                resolved.append({**d, "action": action, "t": t})
    return resolved, warnings
