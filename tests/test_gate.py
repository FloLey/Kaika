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
