"""Unit tests for the modulator (value) cards — math / lfo / noise / shaper.

These exercise the pure value resolvers and their integration through
`build_params` (an LFO/math/shaper wired into a fluid param becomes a per-frame
native-unit array). No DB or real audio. Run with ``.venv/bin/python -m pytest``.
"""

import numpy as np

from backend import graph


def _fluid_with_port(key, node_id, lo, hi):
    return {
        "id": "n-fluid01",
        "type": "fluid",
        "x": 0,
        "y": 0,
        "data": {
            "static": {"color": [0.3, 0.7, 1.0]},
            "ports": {key: {"binding": {"kind": "node", "nodeId": node_id, "lo": lo, "hi": hi}}},
        },
    }


def _seg():
    return {"start": 0.0, "end": 2.0, "signals": []}


def _build(graph_dict):
    return graph.build_params(
        "job", _seg(), graph_dict, lambda j, s: None, output={"fps": 24, "width": 256, "height": 256}
    )


# --------------------------------------------------------------------------- #
# Pure resolvers
# --------------------------------------------------------------------------- #
def test_lfo_sine_is_unit_range_and_right_length():
    c = graph._lfo_curve({"shape": "sine", "rateMode": "cycles", "rate": 2}, 48, 24)
    assert c.shape == (48,)
    assert 0.0 <= float(c.min()) and float(c.max()) <= 1.0
    assert float(c.max()) > 0.9 and float(c.min()) < 0.1  # a full sine sweep


def test_lfo_square_duty():
    c = graph._lfo_curve(
        {"shape": "square", "rateMode": "cycles", "rate": 1, "duty": 0.25}, 100, 50
    )
    # ~quarter of the frames high
    assert 0.2 < float((c > 0.5).mean()) < 0.3


def test_noise_is_deterministic_by_seed():
    a = graph._noise_curve({"seed": 7, "octaves": 2, "rate": 1}, 48, 24)
    b = graph._noise_curve({"seed": 7, "octaves": 2, "rate": 1}, 48, 24)
    c = graph._noise_curve({"seed": 8, "octaves": 2, "rate": 1}, 48, 24)
    assert np.allclose(a, b)
    assert not np.allclose(a, c)
    assert 0.0 <= float(a.min()) and float(a.max()) <= 1.0


def test_math_ops():
    half = np.full(4, 0.5, np.float32)
    one = np.ones(4, np.float32)
    zero = np.zeros(4, np.float32)
    assert np.allclose(graph._math_combine([half, half], "multiply", 0.5, 4), 0.25)
    assert np.allclose(graph._math_combine([half, half], "add", 0.5, 4), 1.0)
    assert np.allclose(graph._math_combine([one, zero], "min", 0.5, 4), 0.0)
    assert np.allclose(graph._math_combine([one, zero], "max", 0.5, 4), 1.0)
    # mix crossfades the first two inputs
    assert np.allclose(graph._math_combine([zero, one], "mix", 0.25, 4), 0.25)
    assert np.allclose(graph._math_combine([], "multiply", 0.5, 4), 0.0)


def test_shaper_invert_and_remap():
    ramp = np.linspace(0.0, 1.0, 5, dtype=np.float32)
    out = graph._shaper_curve(ramp, {"invert": True, "lo": 0.0, "hi": 0.5}, 24)
    assert float(out[0]) > float(out[-1])  # inverted
    assert float(out.max()) <= 0.5 + 1e-6  # remapped into [0, 0.5]


def test_shaper_delay_zero_pads_head():
    # attack/release 0 => the follower is identity, isolating the time-shift.
    base = np.zeros(8, np.float32)
    base[1] = 1.0
    out = graph._shaper_curve(base, {"delay": 125.0, "attack": 0, "release": 0}, 24)
    # 125ms @ 24fps = 3 frames: the impulse slides 1 -> 4 and the head is zero.
    assert int(np.argmax(out)) == 4
    assert float(out[:4].max()) == 0.0


def test_shaper_delay_wrap_recirculates_tail():
    base = np.zeros(8, np.float32)
    base[7] = 1.0
    out = graph._shaper_curve(
        base, {"delay": 125.0, "wrap": True, "attack": 0, "release": 0}, 24
    )
    # shift 3 with wrap: index 7 -> (7 + 3) % 8 = 2 (the tail reappears at the head).
    assert int(np.argmax(out)) == 2


# --------------------------------------------------------------------------- #
# Integration through build_params
# --------------------------------------------------------------------------- #
def test_lfo_into_fluid_param_becomes_array():
    g = {
        "version": 3,
        "nodes": [
            {"id": "lfo1", "type": "lfo", "x": 0, "y": 0, "data": {"rateMode": "cycles", "rate": 3}},
            _fluid_with_port("emit", "lfo1", 0.0, 1.0),
        ],
        "edges": [
            {"id": "e1", "source": "lfo1", "sourcePort": "out", "target": "n-fluid01", "targetPort": "emit"}
        ],
    }
    p = _build(g)
    emit = p["source"]["emit"]
    assert isinstance(emit, list) and len(emit) == 48


def test_chained_math_from_noise_maps_into_range():
    g = {
        "version": 3,
        "nodes": [
            {"id": "n1", "type": "noise", "x": 0, "y": 0, "data": {"seed": 3, "octaves": 2, "rate": 2}},
            {"id": "m1", "type": "math", "x": 0, "y": 0, "data": {"op": "max", "inputs": ["a", "b"]}},
            _fluid_with_port("radius", "m1", 0.02, 0.3),
        ],
        "edges": [
            {"id": "e1", "source": "n1", "sourcePort": "out", "target": "m1", "targetPort": "a"},
            {"id": "e2", "source": "m1", "sourcePort": "out", "target": "n-fluid01", "targetPort": "radius"},
        ],
    }
    p = _build(g)
    radius = p["source"]["radius"]
    assert isinstance(radius, list)
    assert 0.02 <= min(radius) and max(radius) <= 0.3


def test_scope_resolves_and_passes_through():
    g = {
        "version": 6,
        "nodes": [
            {"id": "lfo", "type": "lfo", "x": 0, "y": 0, "data": {"shape": "saw", "rateMode": "cycles", "rate": 2}},
            {"id": "sc", "type": "scope", "x": 0, "y": 0, "data": {}},
        ],
        "edges": [{"id": "e0", "source": "lfo", "sourcePort": "out", "target": "sc", "targetPort": "in"}],
    }
    sc = graph.resolve_node_curve("job", _seg(), g, "sc", lambda j, s: None, fps=30)
    # the scope shows a real, varying curve...
    assert len(sc["curve"]) > 1
    assert 0.0 <= min(sc["curve"]) and max(sc["curve"]) <= 1.0
    assert max(sc["curve"]) - min(sc["curve"]) > 0.5
    # ...and it is EXACTLY its input (a pure pass-through monitor).
    lfo = graph.resolve_node_curve("job", _seg(), g, "lfo", lambda j, s: None, fps=30)
    assert sc["curve"] == lfo["curve"]


def test_scope_into_fluid_param_is_passthrough():
    # fluid.emit bound to a scope (scope <- lfo) resolves identically to binding the lfo.
    base_nodes = [{"id": "lfo", "type": "lfo", "x": 0, "y": 0, "data": {"rateMode": "cycles", "rate": 3}}]
    via_scope = {
        "version": 6,
        "nodes": base_nodes
        + [
            {"id": "sc", "type": "scope", "x": 0, "y": 0, "data": {}},
            _fluid_with_port("emit", "sc", 0.0, 1.0),
        ],
        "edges": [
            {"id": "e0", "source": "lfo", "sourcePort": "out", "target": "sc", "targetPort": "in"},
            {"id": "e1", "source": "sc", "sourcePort": "out", "target": "n-fluid01", "targetPort": "emit"},
        ],
    }
    direct = {
        "version": 6,
        "nodes": base_nodes + [_fluid_with_port("emit", "lfo", 0.0, 1.0)],
        "edges": [{"id": "e1", "source": "lfo", "sourcePort": "out", "target": "n-fluid01", "targetPort": "emit"}],
    }
    assert _build(via_scope)["source"]["emit"] == _build(direct)["source"]["emit"]


def test_scope_with_no_input_is_flat_zero():
    g = {"version": 6, "nodes": [{"id": "sc", "type": "scope", "x": 0, "y": 0, "data": {}}], "edges": []}
    out = graph.resolve_node_curve("job", _seg(), g, "sc", lambda j, s: None, fps=24)
    assert set(out["curve"]) == {0.0}


def test_value_cycle_degrades_to_flat_zero_not_infinite_loop():
    # A (invalid) shaper->shaper cycle must not hang build_params.
    g = {
        "version": 3,
        "nodes": [
            {"id": "s1", "type": "shaper", "x": 0, "y": 0, "data": {}},
            {"id": "s2", "type": "shaper", "x": 0, "y": 0, "data": {}},
            _fluid_with_port("emit", "s1", 0.0, 1.0),
        ],
        "edges": [
            {"id": "e1", "source": "s2", "sourcePort": "out", "target": "s1", "targetPort": "in"},
            {"id": "e2", "source": "s1", "sourcePort": "out", "target": "s2", "targetPort": "in"},
            {"id": "e3", "source": "s1", "sourcePort": "out", "target": "n-fluid01", "targetPort": "emit"},
        ],
    }
    p = _build(g)  # must return, not hang
    assert isinstance(p["source"]["emit"], list)
