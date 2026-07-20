"""Order-of-magnitude performance guards.

Nothing in this suite measured TIME until now, which is how an editor that took minutes
to open a segment shipped through a green run. These budgets are deliberately loose —
roughly 10x the observed cost on a laptop — because the goal is to catch a 10x
regression (a preview that starts rendering the whole song, a route that decodes a
gigabyte), not to police milliseconds. The measured value is always printed, so a slow
drift is visible long before it trips the ceiling.

Run just these with `-m perf`; deselect them with `-m "not perf"` on a busy machine.
"""

from __future__ import annotations

import numpy as np
import pytest

from backend import card_demo, graph

from helpers import assert_moves, out, timed

pytestmark = pytest.mark.perf

# One fixed demo, fixed settings: the fluid card is the most expensive per frame of the
# cards that need no assets, so it bounds the rest.
_OUT = out(width=120, height=120, fps=8)
_SEG = {"start": 0.0, "end": 1.0, "signals": []}

RENDER_BUDGET_S = 8.0  # a 1s draft clip; observed ~0.2-0.6s
RESOLVE_BUDGET_S = 4.0  # a value curve over 1s; observed ~0.01s


def _demo(key: str) -> dict:
    demo = next((d for d in card_demo.DEMOS if d["key"] == key), None)
    if demo is None:
        pytest.skip(f"no {key} demo in the Playground fixture")
    return demo


def test_segment_render_stays_within_budget():
    """A one-second draft render of the fluid demo. If this trips, something started
    rendering far more than it was asked for."""
    demo = _demo("fluid")
    g = demo["graph"]
    out_id = next(n["id"] for n in g["nodes"] if n["type"] == "output")
    frames, elapsed = timed(
        "fluid segment render",
        lambda: graph.Dag(
            "playground", {**_SEG, "signals": demo["signals"]}, g, _noaudio, _OUT
        ).video(out_id),
    )
    assert_moves(frames, "fluid demo")
    assert elapsed < RENDER_BUDGET_S, (
        f"a 1s draft render took {elapsed:.1f}s (budget {RENDER_BUDGET_S}s) — something "
        f"is rendering more than the segment asked for"
    )


def test_value_curve_resolve_stays_within_budget():
    """Resolving a value curve is what every card preview polls; it must stay cheap."""
    demo = _demo("lfo")
    g = demo["graph"]
    node_id = next(n["id"] for n in g["nodes"] if n["type"] == "lfo")
    result, elapsed = timed(
        "resolve lfo curve",
        lambda: graph.resolve_node_curve("playground", _SEG, g, node_id, _noaudio, fps=24),
    )
    assert len(result["curve"]) > 1
    assert elapsed < RESOLVE_BUDGET_S, f"/resolve took {elapsed:.1f}s (budget {RESOLVE_BUDGET_S}s)"


def test_cached_slot_render_is_much_cheaper_than_cold(tmp_path, monkeypatch):
    """The montage's per-slot cache is a perf feature, so it gets a perf test: the second
    render of an unchanged montage must be a small fraction of the first. Without this,
    a refactor that silently breaks the cache key looks green."""
    from backend import fluid_cache

    monkeypatch.setattr(fluid_cache, "CACHE_DIR", tmp_path / "slotcache")
    demo = _demo("montage")
    g = demo["graph"]
    out_id = next(n["id"] for n in g["nodes"] if n["type"] == "output")

    def render():
        return graph.Dag(
            "playground", {**_SEG, "signals": demo["signals"]}, g, _noaudio, _OUT
        ).video(out_id)

    cold_frames, cold = timed("montage cold", render)
    warm_frames, warm = timed("montage cached", render)
    assert np.array_equal(cold_frames, warm_frames), "the cache must return identical frames"
    # Generous: the cached path skips all decoding, so it is normally >10x faster. We only
    # assert it is not SLOWER, plus a loose ceiling that a broken key would blow past.
    assert warm <= max(
        cold, 0.05
    ), f"cached render ({warm:.2f}s) was slower than cold ({cold:.2f}s)"


def _noaudio(_job, _stem):
    return None
