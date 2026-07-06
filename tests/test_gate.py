"""The gate value card: hysteresis thresholding of a 0..1 curve into a clean 0/1."""

import numpy as np

from backend.graph_modulators import _gate_curve, _make_value_resolver


def test_gate_arms_and_releases_around_the_band():
    # threshold 0.5, hysteresis 0.2 -> arm at >= 0.6, release below 0.4.
    base = np.array([0.0, 0.55, 0.65, 0.5, 0.45, 0.35, 0.55, 0.7], np.float32)
    out = _gate_curve(base, {"threshold": 0.5, "hysteresis": 0.2})
    #                 0.0  0.55  0.65  0.5  0.45  0.35  0.55  0.7
    assert out.tolist() == [0.0, 0.0, 1.0, 1.0, 1.0, 0.0, 0.0, 1.0]


def test_gate_hysteresis_prevents_flicker():
    # A signal wobbling INSIDE the band must hold its state.
    wobble = np.array([0.7, 0.45, 0.55, 0.48, 0.52, 0.3], np.float32)
    out = _gate_curve(wobble, {"threshold": 0.5, "hysteresis": 0.2})
    assert out.tolist() == [1.0, 1.0, 1.0, 1.0, 1.0, 0.0]  # stays armed through the wobble


def test_gate_invert_flips():
    base = np.array([0.0, 1.0], np.float32)
    out = _gate_curve(base, {"threshold": 0.5, "hysteresis": 0.0, "invert": True})
    assert out.tolist() == [1.0, 0.0]


def test_gate_defaults_leave_the_square_untouched():
    # divide 1 + minGap 0 (the defaults) must render identically to no thinning,
    # so existing graphs are unaffected.
    base = np.array([0.0, 0.55, 0.65, 0.5, 0.45, 0.35, 0.55, 0.7], np.float32)
    plain = _gate_curve(base, {"threshold": 0.5, "hysteresis": 0.2})
    defaulted = _gate_curve(base, {"threshold": 0.5, "hysteresis": 0.2, "divide": 1, "minGap": 0}, fps=24)
    assert defaulted.tolist() == plain.tolist()


def test_gate_divide_keeps_every_nth_spike():
    # Four unit pulses (threshold 0.5, no hysteresis). 1/2 keeps pulses 0 and 2.
    base = np.array([1, 0, 1, 0, 1, 0, 1, 0], np.float32)
    out = _gate_curve(base, {"threshold": 0.5, "hysteresis": 0.0, "divide": 2})
    assert out.tolist() == [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]


def test_gate_divide_preserves_whole_pulses():
    # Divide drops/keeps ENTIRE pulses, not single frames. 3 pulses, 1/2 -> keep 1st + 3rd.
    base = np.array([1, 1, 0, 1, 1, 0, 1, 1], np.float32)
    out = _gate_curve(base, {"threshold": 0.5, "hysteresis": 0.0, "divide": 2})
    assert out.tolist() == [1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0]


def test_gate_min_gap_drops_close_spikes():
    # Pulses every 2 frames; at fps 10 a 0.3s gap = 3 frames, so consecutive spikes
    # (2 frames apart) get dropped: keep frame 0, next allowed at >= 3 -> keep frame 4.
    base = np.array([1, 0, 1, 0, 1, 0, 1, 0], np.float32)
    out = _gate_curve(base, {"threshold": 0.5, "hysteresis": 0.0, "minGap": 0.3}, fps=10)
    assert out.tolist() == [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]


def test_gate_min_gap_needs_fps():
    # Without fps the seconds->frames conversion can't run, so minGap is a no-op.
    base = np.array([1, 0, 1, 0, 1, 0], np.float32)
    out = _gate_curve(base, {"threshold": 0.5, "hysteresis": 0.0, "minGap": 5.0})
    assert out.tolist() == [1.0, 0.0, 1.0, 0.0, 1.0, 0.0]


def test_resolver_dispatches_gate_over_its_input():
    # lfo(square) -> gate: resolves through the value graph like any modulator.
    graph = {
        "nodes": [
            {"id": "l", "type": "lfo", "data": {"shape": "saw", "rateMode": "cycles", "rate": 1}},
            {"id": "g", "type": "gate", "data": {"threshold": 0.5, "hysteresis": 0.0}},
        ],
        "edges": [{"id": "e", "source": "l", "sourcePort": "out", "target": "g", "targetPort": "in"}],
    }
    nodes = {n["id"]: n for n in graph["nodes"]}
    resolve = _make_value_resolver(graph, nodes, "job", 0.0, 1.0, 24, 24, {}, lambda j, s: None)
    out = resolve("g")
    assert set(np.unique(out)).issubset({0.0, 1.0})  # strictly binary
    assert out[0] == 0.0 and out[-1] == 1.0  # saw ramps 0->1 across the clip
