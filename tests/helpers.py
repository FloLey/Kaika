"""Shared test vocabulary — assertions and builders used across the render tests.

The assertions exist because the suite stayed green through two shipped bugs: a real
segment that rendered 79 frozen frames out of 80, and a card whose preview never moved.
Every render check in the repo measured brightness (`test_card_impact`) or compared two
DIFFERENT renders — nothing ever compared frame i to frame i+1, so a clip of 80 identical
images passed exactly like an animated one.
"""

from __future__ import annotations

import numpy as np

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


def graph_of(nodes: list, edges: list, version: int = 28) -> dict:
    return {"version": version, "nodes": nodes, "edges": edges}
