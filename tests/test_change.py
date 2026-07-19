"""The change card: smoothed |derivative| of a value curve (units/second), the
direction filter, the release-driven decay, and the value-resolver dispatch."""

import numpy as np

from backend.graph_modulators import _change_curve, _make_value_resolver

FPS = 24


def _ramp_then_flat(rate: float = 1.0, secs: float = 1.0) -> np.ndarray:
    """A curve rising at `rate` units/sec for `secs`, then holding."""
    n = int(FPS * secs)
    ramp = np.arange(n, dtype=np.float32) * (rate / FPS)
    return np.concatenate([ramp, np.full(n, ramp[-1] if n else 0.0, np.float32)])


def test_constant_rate_reads_the_rate():
    """A 0→1 sweep over one second reads ≈1.0 once the attack has settled."""
    out = _change_curve(_ramp_then_flat(1.0), {}, FPS)
    assert abs(float(out[FPS // 2]) - 1.0) < 0.05
    # gain scales it (clamped 0..1)
    half = _change_curve(_ramp_then_flat(1.0), {"gain": 0.5}, FPS)
    assert abs(float(half[FPS // 2]) - 0.5) < 0.05


def test_flat_input_reads_zero():
    out = _change_curve(np.full(2 * FPS, 0.7, np.float32), {}, FPS)
    assert float(out.max()) == 0.0


def test_direction_filters_rises_and_falls():
    up = _ramp_then_flat(1.0)  # moves in its FIRST half…
    down = up[::-1].copy()  # …reversed: flat first, descends in its SECOND half
    mid_up, mid_down = FPS // 2, FPS + FPS // 2
    # rise-only: sees the climb, blind to the descent
    assert _change_curve(up, {"direction": "rise"}, FPS)[mid_up] > 0.5
    assert (
        float(_change_curve(down, {"direction": "rise", "attack": 0, "release": 0}, FPS).max())
        == 0.0
    )
    # fall-only: the mirror
    assert _change_curve(down, {"direction": "fall"}, FPS)[mid_down] > 0.5
    assert (
        float(_change_curve(up, {"direction": "fall", "attack": 0, "release": 0}, FPS).max()) == 0.0
    )


def test_release_makes_the_bump_linger_then_decay():
    """After the movement stops, the output decays with the release constant — still
    warm shortly after, mostly gone later. (This lingering is what lets a downstream
    gate see one clean pulse per transition.)"""
    out = _change_curve(_ramp_then_flat(1.0), {"release": 400}, FPS)
    end_of_ramp = FPS - 1
    just_after = out[end_of_ramp + FPS // 4]  # +0.25s: still well above zero
    much_later = out[-1]  # +1s: mostly decayed
    assert just_after > 0.4
    assert much_later < just_after / 2
    # a tiny release drops almost immediately
    fast = _change_curve(_ramp_then_flat(1.0), {"release": 10}, FPS)
    assert fast[end_of_ramp + FPS // 4] < 0.1


def test_resolver_dispatches_change_over_its_input():
    """Graph lfo → change: the resolver feeds the LFO's curve through _change_curve.
    A sine's |derivative| peaks at the zero crossings — where the sine itself is 0.5."""
    graph = {
        "nodes": [
            {"id": "l", "type": "lfo", "data": {"shape": "sine", "rateMode": "cycles", "rate": 2}},
            {"id": "c", "type": "change", "data": {"release": 100}},
        ],
        "edges": [
            {"id": "e", "source": "l", "sourcePort": "out", "target": "c", "targetPort": "in"}
        ],
    }
    nodes = {n["id"]: n for n in graph["nodes"]}
    nframes = 2 * FPS
    resolve = _make_value_resolver(
        graph, nodes, "job", 0.0, 2.0, nframes, FPS, {}, lambda j, s: None
    )
    lfo, chg = resolve("l"), resolve("c")
    assert chg.shape == (nframes,)
    assert float(chg.max()) > 0.3  # the sine IS moving
    # the change peaks near the sine's steepest point, not at its crest
    assert abs(float(lfo[int(np.argmax(chg))]) - 0.5) < 0.25


def test_resolver_change_without_input_is_flat_zero():
    graph = {"nodes": [{"id": "c", "type": "change", "data": {}}], "edges": []}
    resolve = _make_value_resolver(
        graph, {"c": graph["nodes"][0]}, "job", 0.0, 1.0, FPS, FPS, {}, lambda j, s: None
    )
    assert float(resolve("c").max()) == 0.0
