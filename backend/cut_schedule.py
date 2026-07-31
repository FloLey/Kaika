"""The cut schedule shared by the montage and Dream cards, plus Dream's per-frame plan.

A *cut schedule* splits a composition's window into parts: the rising edges of a wired
`trigger` (through the card's own hysteresis threshold), unioned with hand-placed manual
breakpoints, minus individually disabled gate cuts. The montage plays one extract per
part; Dream generates under one prompt per part. Both cards carry the same four data
fields, so they share this code rather than the intent — a schedule that drifted between
them would be a bug nobody could see.

This is a LEAF module (numpy + nothing of ours but `graph_modulators._gate_curve`) so the
schedule can be imported and tested without dragging in the render DAG — the same reason
`VIDEO_PRODUCERS` lives in `graph_common`. The dag-aware wrapper that re-resolves a
trigger at the project's editing fps stays in `graph_render` as `_cut_frames`.

Frontend mirror: `frontend/src/lib/cutSchedule.ts`. The two MUST agree — the timeline
draws from one and the render generates from the other — which `tests/fixtures/
cut_schedule_cases.json` is there to enforce from both sides.
"""

from __future__ import annotations

import numpy as np

from .graph_modulators import _gate_curve

# A gap between two sung lines shorter than this is not a real silence — it is the
# padding `segment.align_lines` adds to every `t1` for readability, clamped at the next
# line's `t0`. Cutting on those would spawn one-frame "instrumental" parts between every
# pair of back-to-back lines.
MIN_GAP_S = 0.3


def lyric_cuts(
    lines,
    seg_start: float,
    fps: float,
    nframes: int,
    *,
    instrumental: bool = True,
    skip_unaligned: bool = False,
) -> list[tuple[int, bool]]:
    """Cut frames derived from aligned lyric lines → [(frame, is_gap_start), …].

    `is_gap_start` marks a cut that OPENS a silence (an instrumental stretch) rather than
    a sung line, so the caller can give those parts their own prompt.

    Lyric lines are SONG-ABSOLUTE (`sources_text.py`), while every other time on a
    scheduled card is composition-LOCAL — this is the one place the two meet, so the
    conversion happens here and nowhere else.

    Only real silences become gap cuts. `align_lines` pads every `t1` to at least
    `t0 + 1.7s` and then clamps it to the next line's `t0`, so two back-to-back lines have
    a ZERO-length gap: `t1` is a display duration, not the moment singing stopped. Cutting
    on every `t1` would therefore litter the schedule with one-frame parts.

    `skip_unaligned` drops lines whose timings were interpolated rather than heard
    (`aligned: false`) — their `t0` is arithmetic, so a cut there lands where nothing is
    sung.
    """
    rows = []
    for ln in lines or []:
        try:
            t0, t1 = float(ln.get("t0")), float(ln.get("t1"))
        except (TypeError, ValueError, AttributeError):
            continue
        if skip_unaligned and ln.get("aligned") is False:
            continue
        rows.append((t0, t1))
    rows.sort()

    out: list[tuple[int, bool]] = []
    for i, (t0, t1) in enumerate(rows):
        out.append((int(round((t0 - seg_start) * fps)), False))
        if not instrumental:
            continue
        # What bounds this line's trailing silence: the next line, or — for the last
        # one — the END OF THE WINDOW. Using `t1 + MIN_GAP_S` there would be both
        # arbitrary and float-fragile (4.3 - 4.0 == 0.29999…, so the final silence
        # vanished depending on the numbers).
        nxt = rows[i + 1][0] if i + 1 < len(rows) else seg_start + nframes / fps
        if nxt - t1 >= MIN_GAP_S:
            out.append((int(round((t1 - seg_start) * fps)), True))
    # Frame 0 is where part 0 already starts, and anything past the window never plays —
    # `effective_cuts` applies the same clamp to the gate and manual sources.
    return [(f, g) for f, g in out if 1 <= f < nframes]


def effective_cuts(
    trigger: np.ndarray,
    d: dict,
    fps: float,
    nframes: int,
    lyric: list[int] | None = None,
) -> list[int]:
    """The effective cut frames: GATE rises (the trigger through the card's built-in
    hysteresis threshold, exactly like the slideshow) minus the individually DISABLED
    ones, unioned with the MANUAL breakpoints and any LYRIC cuts — sorted, deduped at
    frame granularity, clamped inside (0, nframes).

    `lyric` is the frame list from `lyric_cuts` (Dream's "follow the lyrics" mode). It
    joins the union at the same point as the manual breakpoints and obeys the same
    `disabledCuts` suppression, so an unwanted line boundary is switched off with the
    machinery that already exists rather than a second mechanism.

    `disabledCuts` stores composition-LOCAL seconds; an entry suppresses ANY cut within
    HALF A FRAME of it — gate or manual — so the match is deterministic and a gate cut
    that MOVED (threshold edit) re-enables itself. Suppressing manuals too matters (v17):
    a manual breakpoint sharing a disabled gate cut's frame used to resurrect the cut the
    user just clicked off, while the timeline (where the gate mark wins the collision
    pixel) showed it silenced — the render cut where the UI said it wouldn't. The editor's
    gestures keep such data rare (disabling sweeps same-frame manuals, placing a manual
    clears a stale disable), but saved projects carry it. Manual breakpoints are local
    seconds too."""
    gate = _gate_curve(
        trigger, {"threshold": d.get("threshold", 0.5), "hysteresis": d.get("hysteresis", 0.1)}
    )
    rises = np.nonzero(np.diff(gate) > 0)[0] + 1  # frame index where each cut lands
    disabled = []
    for t in d.get("disabledCuts") or []:
        try:
            disabled.append(float(t) * fps)
        except (TypeError, ValueError):
            continue

    def silenced(frame: int) -> bool:
        return any(abs(frame - f) <= 0.5 for f in disabled)

    cuts = {int(r) for r in rises if not silenced(int(r))}
    for bp in d.get("manualBreakpoints") or []:
        try:
            f = int(round(float((bp or {}).get("t")) * fps))
        except (TypeError, ValueError):
            continue
        if not silenced(f):
            cuts.add(f)
    for f in lyric or []:
        if not silenced(int(f)):
            cuts.add(int(f))
    return sorted(c for c in cuts if 1 <= c < nframes)


def part_starts(cuts: list[int], spans: list[int]) -> list[int]:
    """Absolute start frame of each PLAYED part. Frame 0 always starts part 0; part k
    swallows `spans[k]` effective cuts before the next starts. Cuts beyond the parts are
    IGNORED — as is a part whose starting cut never arrives — so the last STARTED part
    HOLDS to the segment end. Part k is active on [starts[k], starts[k+1])."""
    starts = [0]
    consumed = 0
    for span in spans[:-1]:  # the last part never hands over — its span is moot
        consumed += span
        if consumed - 1 >= len(cuts):
            break  # not enough cuts left — the part that just played holds
        starts.append(int(cuts[consumed - 1]))
    return starts


def _clamped_fades(prompts: list[dict], starts: list[int], nframes: int, fps: float) -> list[tuple]:
    """(fadeIn, fadeOut) seconds per part, capped so `fadeIn + fadeOut <= the part's own
    duration`, both scaled down proportionally on overflow.

    This is not tidiness — it is exactly the condition under which two adjacent
    transitions cannot overlap. Transition k-1 -> k ends at `c_k + i_k`; transition
    k -> k+1 begins at `c_k + D_k - o_k`; they stay disjoint iff `i_k + o_k <= D_k`. So
    the clamp is what guarantees at most TWO prompts ever blend at once, which is in turn
    what lets the embedding lerp take a pair (imagegen._dream_embeds) and the cache key
    take a pair (dream_cache.canonical_prompts).
    """
    out = []
    for k in range(len(starts)):
        end = starts[k + 1] if k + 1 < len(starts) else nframes
        dur = max(0.0, (end - starts[k]) / fps)
        p = prompts[k] if k < len(prompts) else {}
        fi = max(0.0, float(p.get("fadeIn") or 0.0))
        fo = max(0.0, float(p.get("fadeOut") or 0.0))
        total = fi + fo
        if total > dur and total > 0:
            scale = dur / total
            fi, fo = fi * scale, fo * scale
        out.append((fi, fo))
    return out


def dream_plan(
    cuts: list[int],
    prompts: list[dict],
    fps: float,
    nframes: int,
    *,
    seed: int = 1,
    seed_mode: str = "gate",
    reseed_frames: list[int] | None = None,
    scale=None,
    keep=None,
    shape: float = 1.0,
) -> list[dict]:
    """One `{prompt_a, prompt_b, w, seed, scale, keep}` per frame — what
    `imagegen.dream_frames` consumes and `dream_cache` keys on.

    `prompts` is the card's ordered prompt list; each entry may carry `fadeIn`, `fadeOut`
    and `span`. `scale` is the resolved `control_scale` curve (per frame) or None;
    `keep` likewise, and it only reaches the pipe when a `video` input is wired (with no
    source clip there is nothing to seed from).
    """
    if not prompts:
        raise ValueError("dream_plan: no prompts")
    nframes = max(1, int(nframes))
    spans = [max(1, int(p.get("span") or 1)) for p in prompts]
    starts = part_starts(cuts, spans)
    fades = _clamped_fades(prompts, starts, nframes, fps)

    # Reseed events. In `gate` mode an unwired `reseed` port falls back to the CUT
    # schedule, so the natural default is "a fresh image family per prompt" with nothing
    # wired; wiring a separate signal re-rolls WITHIN a part.
    events = sorted(reseed_frames) if reseed_frames is not None else list(cuts)

    plan = []
    for f in range(nframes):
        k = 0
        while k + 1 < len(starts) and starts[k + 1] <= f:
            k += 1
        a = str(prompts[k].get("text") or "")
        b, w = None, 0.0

        # Am I inside the transition INTO this part, or the one OUT of it?
        t = f / fps
        if k > 0:  # incoming edge: [c - fadeOut(k-1), c + fadeIn(k)]
            c = starts[k] / fps
            o, i = fades[k - 1][1], fades[k][0]
            if t < c + i:
                a, b = str(prompts[k - 1].get("text") or ""), str(prompts[k].get("text") or "")
                w = _weight(t, c, o, i, shape)
        if k + 1 < len(starts):  # outgoing edge: [c - fadeOut(k), c + fadeIn(k+1)]
            c = starts[k + 1] / fps
            o, i = fades[k][1], fades[k + 1][0]
            if t >= c - o and o > 0:
                a, b = str(prompts[k].get("text") or ""), str(prompts[k + 1].get("text") or "")
                w = _weight(t, c, o, i, shape)

        plan.append(
            {
                "prompt_a": a,
                "prompt_b": b if w > 0 else None,
                "w": float(w),
                "seed": _seed_for(f, seed, seed_mode, events),
                "scale": 0.7 if scale is None else float(scale[min(f, len(scale) - 1)]),
                "keep": 0.1 if keep is None else float(keep[min(f, len(keep) - 1)]),
            }
        )
    return plan


def _shaped(u: float, shape: float) -> float:
    """Remap a linear fade fraction `u` through the card's fade SHAPE.

    `shape` 1.0 is the identity — a linear ramp, and the default. Above 1 the curve
    flattens around the midpoint, so the fade spends most of its duration near w = 0.5;
    below 1 it steepens there.

    Why this exists: the two models do not interpolate alike. SD-Turbo morphs steadily
    across the whole 0->1 sweep, but Z-Image is continuous-yet-STEEP — measured on the
    step-01 probe, essentially all of its visual change happens inside w in [0.42, 0.62].
    A linear ramp therefore spends ~80% of an HD fade window showing almost nothing and
    ~20% doing all the work, which reads as a soft cut rather than a dissolve. At shape 3
    about 58% of the window lands inside that band instead of 20%.

    It is a control rather than a per-model constant on purpose: the band was measured on
    ONE prompt pair, and nothing says it is the same for others. A hardcoded curve would
    be right on the probe and silently wrong elsewhere; a knob is honest about that.
    """
    if shape == 1.0 or u <= 0.0 or u >= 1.0:
        return u
    s = 2.0 * u - 1.0
    return 0.5 + 0.5 * (1.0 if s >= 0 else -1.0) * abs(s) ** shape


def _weight(t: float, c: float, o: float, i: float, shape: float = 1.0) -> float:
    """Blend weight at time `t` for a transition at cut time `c` with `o` seconds of
    lead-out and `i` seconds of lead-in. Both zero is a hard cut: 0 before `c`, 1 at and
    after it. Otherwise a ramp across [c-o, c+i] — linear at shape 1, so at the cut itself
    you are `o/(o+i)` of the way across."""
    if o + i <= 0:
        return 1.0 if t >= c else 0.0
    if t <= c - o:
        return 0.0
    if t >= c + i:
        return 1.0
    return _shaped((t - (c - o)) / (o + i), shape)


def _seed_for(f: int, seed: int, mode: str, events: list[int]) -> int:
    """Deterministic in every mode — non-determinism would poison the frame cache."""
    if mode == "frame":
        return int(seed) + f
    if mode == "gate":
        n = 0
        for e in events:
            if e <= f:
                n += 1
            else:
                break
        return int(seed) + n
    return int(seed)  # "fixed"
