"""Shared test vocabulary — assertions and builders used across the render tests.

The assertions exist because the suite stayed green through two shipped bugs: a real
segment that rendered 79 frozen frames out of 80, and a card whose preview never moved.
Every render check in the repo measured brightness (`test_card_impact`) or compared two
DIFFERENT renders — nothing ever compared frame i to frame i+1, so a clip of 80 identical
images passed exactly like an animated one.

`assert_frames_close` covers the other axis. Comparing two renders was never missing — it
was hand-rolled in nine files under four different tolerances, with no shared answer to
"what does agree mean?". Wave 3's perf work needs one, because a windowed Gaussian is
supposed to be *nearly* identical and someone has to say how near.
"""

from __future__ import annotations

import re
import time
from functools import lru_cache
from pathlib import Path

import numpy as np

_FACTORIES = (
    Path(__file__).resolve().parents[1] / "frontend" / "src" / "lib" / "graph" / "factories.ts"
)


@lru_cache(maxsize=1)
def graph_version() -> int:
    """`GRAPH_VERSION` read from its ONE source of truth (`factories.ts`).

    This used to be a hardcoded `28` in `graph_of`'s signature. A bump on the frontend
    would have left fixture graphs stamped at the old version — invisible to pytest and,
    per ARCHITECTURE.md's own warning, enough to silently drop a card the moment the UI
    loads the graph. Deriving it means the bump propagates or this raises.
    """
    m = re.search(r"export const GRAPH_VERSION = (\d+)", _FACTORIES.read_text())
    assert m, f"GRAPH_VERSION not found in {_FACTORIES} — did the declaration move?"
    return int(m.group(1))


# One documented default for render settings. Deliberately NOT retrofitted over the
# per-file `OUT` dicts: theirs differ in size/fps/background in ways their assertions
# depend on. New tests use this; an old one migrates only when touched for another reason.
_DEFAULT_OUT = {"width": 96, "height": 128, "quality": "draft", "fps": 24}


def out(**overrides) -> dict:
    """The default render settings, with overrides. `out(fps=8, width=120)`."""
    return {**_DEFAULT_OUT, **overrides}


def _flat_rgb(frames: np.ndarray) -> np.ndarray:
    """RGB view of a frame stack: RGBA layers composite over black, 3-channel passes."""
    from backend import fluid

    return fluid.flatten(frames) if frames.shape[-1] == 4 else frames


# Motion floors, calibrated by measuring all 34 Playground demos (120x120, 8fps, 1s):
# every one moves, the weakest being the `image` card at mean |delta| = 0.65 and the
# strongest `montage` at 35.4. A FROZEN clip measures 0.0 with 1 distinct frame. 0.1
# therefore sits ~6x below the weakest real card and far above any frozen render.
# The distinct-frame floor is separate because stepping cards (slideshow, imagegen)
# legitimately hold each still for several frames — 3 distinct frames out of 8 — so a
# per-frame delta alone would be the wrong shape for them.
MIN_MEAN_DELTA = 0.1
MIN_DISTINCT_FRAMES = 2


def frame_motion(frames: np.ndarray) -> tuple[float, int]:
    """`(mean |frame[i+1] - frame[i]|, number of distinct frames)` for a frame stack."""
    rgb = _flat_rgb(np.asarray(frames))
    if len(rgb) < 2:
        return 0.0, len(rgb)
    delta = float(np.abs(np.diff(rgb.astype(np.int16), axis=0)).mean())
    return delta, len({f.tobytes() for f in rgb})


def assert_moves(frames: np.ndarray, label: str = "") -> None:
    """Fail if a clip is (near-)static. The message reports the measured numbers, so a
    red test says HOW static the render is rather than just that it failed."""
    delta, distinct = frame_motion(frames)
    what = f"{label}: " if label else ""
    assert delta >= MIN_MEAN_DELTA and distinct >= MIN_DISTINCT_FRAMES, (
        f"{what}render is static — mean frame-to-frame delta {delta:.3f} "
        f"(floor {MIN_MEAN_DELTA}), {distinct} distinct frame(s) of {len(frames)} "
        f"(floor {MIN_DISTINCT_FRAMES})"
    )


def assert_not_black(frames: np.ndarray, label: str = "") -> None:
    """Fail if a clip is visually black. `max > 0` was too lax: a kaleidoscope sampling
    empty space rendered peak 2 (black to the eye) and still passed. Every real demo
    clears peak >= 216 and lights >= 6.7% of its pixels, so these floors sit far below
    any legitimate pipeline yet catch a dark one."""
    rgb = _flat_rgb(np.asarray(frames))
    peak = int(rgb.max())
    lit = float((rgb.max(axis=3) > 8).mean())
    what = f"{label}: " if label else ""
    assert peak >= 32, f"{what}render is visually black (peak brightness {peak})"
    assert lit >= 0.005, f"{what}render lights only {lit:.3%} of its pixels"


def assert_frames_close(
    a: np.ndarray,
    b: np.ndarray,
    *,
    atol: int = 0,
    mean_atol: float = 0.0,
    label: str = "",
    why: str = "",
) -> None:
    """Two renders of the same thing agree. EXACT unless a tolerance is stated.

    `atol` bounds the worst single channel value (in 8-bit levels); `mean_atol` bounds the
    clip-wide mean. Both are checked and both default to 0, so weakening this assertion is
    always someone typing a number — never an omission.

    Why two bounds and not one: `test_card_impact` compares whole-vs-streamed by clip-wide
    MEAN on purpose, because ffmpeg seeking makes video-backed cards differ by a hair at
    block seams and a max bound fails on them. But a mean alone hides the opposite failure —
    a large divergence confined to three frames averages into nothing across a whole clip.
    One bound each way catches both shapes. `test_flatten_contract` already paired them by
    hand; this is that pairing, named.

    A nonzero tolerance must carry `why`. Every floor in this module justifies its number in
    prose, and a tolerance that travels by copy-paste should drag its reasoning along with
    it — a reviewer then sees a claim to check rather than a bare float.

    NB the stacks are compared AS GIVEN: an RGBA pair is compared on all four channels,
    because an alpha difference is a real difference. Flatten first if you mean to ignore it.
    """
    assert not (atol or mean_atol) or why, "a nonzero tolerance must say why (pass `why=`)"
    what = f"{label}: " if label else ""
    a, b = np.asarray(a), np.asarray(b)
    assert a.shape == b.shape, f"{what}frame stacks differ in shape — {a.shape} vs {b.shape}"
    if a.size == 0:
        return
    # int16 holds the full -255..255 range at half the memory of the int64 these tests
    # otherwise promote to (an HD block is large enough for that to matter).
    d = np.abs(a.astype(np.int16) - b.astype(np.int16))
    worst, mean = int(d.max()), float(d.mean())
    if worst <= atol and mean <= mean_atol:
        return
    # Diagnostics are built only on the failure path — a bare `allclose` cannot tell
    # "you broke the physics" from "you moved one edge pixel", and that distinction is
    # the whole reason this helper exists.
    flat = d.reshape(len(d), -1)
    fi = int(np.argmax(flat.max(axis=1)))
    where = tuple(int(i) for i in np.unravel_index(int(np.argmax(d)), d.shape))
    raise AssertionError(
        f"{what}renders differ — max {worst} (bound {atol}), "
        f"clip mean {mean:.3f} (bound {mean_atol})\n"
        f"  worst frame {fi} of {len(d)}: max {int(flat[fi].max())}, "
        f"mean {float(flat[fi].mean()):.3f}\n"
        f"  {float((d > atol).mean()):.4%} of values over the max bound; "
        f"worst at {where}: {int(a[where])} vs {int(b[where])}"
        + (f"\n  stated tolerance: {why}" if why else "")
    )


def timed(label: str, fn):
    """`(value, seconds)` for one call, printing the measured number.

    Always printing is the point, not a debug leftover: a budget that only speaks when it
    trips tells you nothing about the drift on the way there. Shared by the `perf` budgets
    and the `bench` baselines so both report in one format.
    """
    t0 = time.perf_counter()
    value = fn()
    elapsed = time.perf_counter() - t0
    print(f"\n  [perf] {label}: {elapsed:.2f}s")
    return value, elapsed


# ---- graph builders ---------------------------------------------------------
# Every render test hand-rolls these; the shapes are identical modulo the card's data.
# Adopt on touch — there is no value in rewriting a passing test just to use them.


def edge(source: str, target: str, target_port: str, source_port: str = "out") -> dict:
    return {
        "id": f"{source}-{target}-{target_port}",
        "source": source,
        "sourcePort": source_port,
        "target": target,
        "targetPort": target_port,
    }


def node(node_id: str, node_type: str, **data) -> dict:
    return {"id": node_id, "type": node_type, "data": data}


def graph_of(nodes: list, edges: list, version: int | None = None) -> dict:
    """A graph stamped at the CURRENT `GRAPH_VERSION` unless a version is forced
    (migration tests want an old stamp on purpose)."""
    return {
        "version": graph_version() if version is None else version,
        "nodes": nodes,
        "edges": edges,
    }
