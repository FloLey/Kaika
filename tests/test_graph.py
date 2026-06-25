"""Unit tests for the graph executor (backend.graph).

These exercise the pure logic — param building, validation, hashing — without a
live DB or real audio. `signals.extract` is monkeypatched to return a known ramp,
and `stem_audio_path` is a stub. Run with: ``.venv/bin/python -m pytest``.
"""
import numpy as np
import pytest

from backend import graph
from backend.animation_params import PARAMS


def _fluid_node(ports=None, static=None):
    return {
        "id": "n-fluid01", "type": "fluid", "x": 0, "y": 0,
        "data": {"static": static or {"duration": 2.0, "grid": 48, "fps": 24,
                                       "color": [0.3, 0.7, 1.0]},
                 "ports": ports or {}},
    }


def _output_node(node_id="n-out"):
    return {"id": node_id, "type": "output", "x": 0, "y": 0, "data": {"title": "preview"}}


def _video_edge(fluid_id="n-fluid01", out_id="n-out"):
    return {"id": f"e-{fluid_id}-{out_id}", "source": fluid_id, "sourcePort": "out",
            "target": out_id, "targetPort": "video"}


def _stem_path(job_id, stem):
    return f"/fake/{job_id}/{stem}.wav"


# --------------------------------------------------------------------------- #
# Validation (01 §3.7)
# --------------------------------------------------------------------------- #
def test_validate_ok_minimal():
    g = {"version": 1, "nodes": [_fluid_node(), _output_node()], "edges": [_video_edge()]}
    graph.validate(g)  # no raise


def test_validate_rejects_no_output():
    g = {"version": 1, "nodes": [_fluid_node()], "edges": []}
    with pytest.raises(ValueError, match="output"):
        graph.validate(g)


def test_validate_rejects_no_fluid():
    # An output with nothing wired in (no fluid/combine) is rejected.
    g = {"version": 1, "nodes": [_output_node()], "edges": []}
    with pytest.raises(ValueError, match="exactly one source"):
        graph.validate(g)


def test_validate_rejects_output_not_wired_to_fluid():
    g = {"version": 1, "nodes": [_fluid_node(), _output_node()], "edges": []}
    with pytest.raises(ValueError, match="exactly one source"):
        graph.validate(g)


def test_validate_rejects_dangling_node_binding():
    ports = {"force": {"binding": {"kind": "node", "nodeId": "n-ghost",
                                   "lo": 0.0, "hi": 45.0}}}
    g = {"version": 1, "nodes": [_fluid_node(ports), _output_node()],
         "edges": [_video_edge()]}
    with pytest.raises(ValueError, match="unknown node"):
        graph.validate(g)


# --------------------------------------------------------------------------- #
# Multiple independent pipelines (N fluid -> N output)
# --------------------------------------------------------------------------- #
def _two_pipeline_graph():
    """Two fluids (A force=10, B force=40) each wired to its own output."""
    a = _fluid_node(ports={"force": {"binding": {"kind": "const", "value": 10.0}}})
    a["id"] = "n-fluidA"
    b = _fluid_node(ports={"force": {"binding": {"kind": "const", "value": 40.0}}})
    b["id"] = "n-fluidB"
    return {
        "version": 1,
        "nodes": [a, _output_node("n-outA"), b, _output_node("n-outB")],
        "edges": [_video_edge("n-fluidA", "n-outA"),
                  _video_edge("n-fluidB", "n-outB")],
    }


def test_validate_accepts_two_pipelines():
    graph.validate(_two_pipeline_graph())  # no raise


def test_output_hash_differs_per_output():
    g = _two_pipeline_graph()
    seg = {"start": 0.0, "end": 2.0, "signals": []}
    ha = graph.output_hash("job1", seg, g, "n-outA")
    hb = graph.output_hash("job1", seg, g, "n-outB")
    assert ha != hb


def test_build_params_selects_the_outputs_fluid():
    g = _two_pipeline_graph()
    seg = {"start": 0.0, "end": 2.0, "signals": []}
    pa = graph.build_params("job1", seg, g, _stem_path, output_id="n-outA")
    pb = graph.build_params("job1", seg, g, _stem_path, output_id="n-outB")
    assert pa["source"]["force"] == 10.0
    assert pb["source"]["force"] == 40.0


# --------------------------------------------------------------------------- #
# Param building — const path (backward-compat / defaults)
# --------------------------------------------------------------------------- #
def test_const_binding_is_scalar_default_when_absent():
    g = {"version": 1, "nodes": [_fluid_node(), _output_node()], "edges": []}
    seg = {"start": 0.0, "end": 2.0, "signals": []}
    params = graph.build_params("job1", seg, g, _stem_path)
    # Unbound force falls back to its native default (20.0) as a scalar.
    assert params["source"]["force"] == PARAMS["force"][3]
    assert params["fluid"]["vorticity"] == PARAMS["vorticity"][3]
    assert params["duration"] == 2.0 and params["fps"] == graph.FLUID_FPS


def test_const_binding_uses_value():
    ports = {"force": {"binding": {"kind": "const", "value": 33.0}}}
    g = {"version": 1, "nodes": [_fluid_node(ports), _output_node()], "edges": []}
    seg = {"start": 0.0, "end": 2.0, "signals": []}
    params = graph.build_params("job1", seg, g, _stem_path)
    assert params["source"]["force"] == 33.0


# --------------------------------------------------------------------------- #
# Param building — signal-bound port becomes a per-frame array
# --------------------------------------------------------------------------- #
def test_signal_bound_param_is_per_frame_array(monkeypatch):
    nframes = round(2.0 * graph.FLUID_FPS)  # duration 2 * fps 24 = 48
    ramp = list(np.linspace(0.0, 1.0, nframes))

    def fake_extract(stem_path, start, end, min_hz, max_hz, **kw):
        assert kw["fps"] == graph.FLUID_FPS
        return {"curve": ramp, "times": list(range(nframes)), "fps": graph.FLUID_FPS}

    monkeypatch.setattr(graph.signals, "extract", fake_extract)

    sig_node = {"id": "n-sig", "type": "signal", "x": 0, "y": 0,
                "data": {"signalId": "sig-1", "label": "drums"}}
    ports = {"force": {"binding": {"kind": "node", "nodeId": "n-sig",
                                   "lo": 0.0, "hi": 45.0}}}
    g = {"version": 1, "nodes": [_fluid_node(ports), sig_node, _output_node()],
         "edges": []}
    seg = {"start": 0.0, "end": 2.0, "signals": [
        {"id": "sig-1", "stemKey": "drums", "minHz": 40, "maxHz": 120,
         "feature": "energy", "attack": 5.0, "release": 250.0, "invert": False,
         "gamma": 1.0, "gain": 1.0, "offset": 0.0, "threshold": 0.0},
    ]}
    params = graph.build_params("job1", seg, g, _stem_path)
    force = params["source"]["force"]
    assert isinstance(force, list) and len(force) == nframes
    # Mapped lo + (hi-lo)*curve: ramp 0..1 -> 0..45.
    assert force[0] == pytest.approx(0.0, abs=1e-4)
    assert force[-1] == pytest.approx(45.0, abs=1e-3)


def test_missing_signal_degrades_to_flat_zero(monkeypatch):
    # signalId not present in segment.signals -> flat 0 curve, no extract call.
    def boom(*a, **k):
        raise AssertionError("extract must not be called for a missing signal")

    monkeypatch.setattr(graph.signals, "extract", boom)

    sig_node = {"id": "n-sig", "type": "signal", "x": 0, "y": 0,
                "data": {"signalId": "sig-gone"}}
    ports = {"force": {"binding": {"kind": "node", "nodeId": "n-sig",
                                   "lo": 10.0, "hi": 45.0}}}
    g = {"version": 1, "nodes": [_fluid_node(ports), sig_node, _output_node()],
         "edges": []}
    seg = {"start": 0.0, "end": 2.0, "signals": []}
    params = graph.build_params("job1", seg, g, _stem_path)
    force = params["source"]["force"]
    # curve all 0 -> lo + (hi-lo)*0 = lo everywhere.
    assert all(v == pytest.approx(10.0) for v in force)


# --------------------------------------------------------------------------- #
# Hashing — referenced signal defs change the hash; node position does not.
# --------------------------------------------------------------------------- #
def _sig_graph():
    sig_node = {"id": "n-sig", "type": "signal", "x": 0, "y": 0,
                "data": {"signalId": "sig-1"}}
    ports = {"force": {"binding": {"kind": "node", "nodeId": "n-sig",
                                   "lo": 0.0, "hi": 45.0}}}
    return {"version": 1, "nodes": [_fluid_node(ports), sig_node, _output_node()],
            "edges": []}


def test_hash_includes_referenced_signal_defs():
    g = _sig_graph()
    base_sig = {"id": "sig-1", "stemKey": "drums", "minHz": 40, "maxHz": 120,
                "feature": "energy", "attack": 5.0, "release": 250.0,
                "invert": False, "gamma": 1.0, "gain": 1.0, "offset": 0.0,
                "threshold": 0.0}
    seg_a = {"start": 0.0, "end": 2.0, "signals": [dict(base_sig)]}
    seg_b = {"start": 0.0, "end": 2.0, "signals": [dict(base_sig, maxHz=200)]}
    assert graph.graph_hash("job1", seg_a, g) != graph.graph_hash("job1", seg_b, g)


def test_hash_ignores_node_position():
    g = _sig_graph()
    seg = {"start": 0.0, "end": 2.0, "signals": [
        {"id": "sig-1", "stemKey": "drums", "minHz": 40, "maxHz": 120,
         "feature": "energy", "attack": 5.0, "release": 250.0, "invert": False,
         "gamma": 1.0, "gain": 1.0, "offset": 0.0, "threshold": 0.0}]}
    h1 = graph.graph_hash("job1", seg, g)
    g["nodes"][0]["x"] = 999
    g["nodes"][0]["y"] = 999
    assert graph.graph_hash("job1", seg, g) == h1
