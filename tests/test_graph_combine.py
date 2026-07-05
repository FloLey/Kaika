"""Combine card: merge (shared sim), layered (alpha-over), output passthrough,
and the validation guardrail (spec 10). Const-only fluids need no audio, so these
run without mocking signal extraction. Small grids/durations keep them fast."""

from __future__ import annotations

import shutil

import numpy as np
import pytest

from backend import fluid
from backend import graph as G

# render() encodes an mp4 via ffmpeg; skip those two cases where it's not installed
# (e.g. minimal CI). The frame-level tests use _Dag.video and need no ffmpeg.
_needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")

OUT = {"width": 64, "height": 64, "quality": "draft", "fps": 24, "background": "#101418"}
SEG = {"start": 0.0, "end": 1.0, "signals": []}
NOAUDIO = lambda j, s: None  # noqa: E731  (const fluids never extract a signal)


def _fluid(nid, color, pos, angle):
    r, g, b = color
    ports = {
        k: {"binding": {"kind": "const", "value": v}}
        for k, v in [
            ("r", r),
            ("g", g),
            ("b", b),
            ("angle", angle),
            ("force", 42),
            ("emit", 0.45),
            ("radius", 0.07),
        ]
    }
    return {
        "id": nid,
        "type": "fluid",
        "x": 0,
        "y": 0,
        "data": {
            "static": {
                "enabled": True,
                "radial": False,
                "wrap": True,
                "points": [pos],
                "path_speed": 1,
                "path_closed": False,
                "path_pingpong": False,
                "intensity": 1.0,
                "opacity": 1.0,
                "color": list(color),
            },
            "ports": ports,
        },
    }


def _edge(s, t, tp):
    return {
        "id": f"e-{s}-{t}-{tp}",
        "source": s,
        "sourcePort": "out",
        "target": t,
        "targetPort": tp,
    }


def _combine(mode, op1=1.0):
    return {
        "id": "cb",
        "type": "combine",
        "x": 0,
        "y": 0,
        "data": {
            "mode": mode,
            "inputs": [{"id": "s0", "opacity": 1.0}, {"id": "s1", "opacity": op1}],
            "medium": {"vorticity": 8.0},
        },
    }


def _graph(mode, op1=1.0):
    return {
        "version": 1,
        "nodes": [
            _fluid("fA", (1.0, 0.2, 0.45), [0.25, 0.5], 0),
            _fluid("fB", (0.2, 0.8, 1.0), [0.75, 0.5], 180),
            _combine(mode, op1),
            {"id": "out1", "type": "output", "x": 0, "y": 0, "data": {}},
        ],
        "edges": [_edge("fA", "cb", "s0"), _edge("fB", "cb", "s1"), _edge("cb", "out1", "video")],
    }


def _frames(g):
    dag = G._Dag("job", SEG, g, NOAUDIO, OUT)
    return dag.video(G._video_source(g, "out1", "video"))


# ---- fluid.simulate multi-emitter + background ------------------------------
def test_simulate_sources_list_equals_single_source():
    base = {
        "grid": 32,
        "duration": 1,
        "source": {"force": 20, "color": [0.3, 0.7, 1.0]},
        "fluid": {},
    }
    a, _, _ = fluid.simulate(base)
    b, _, _ = fluid.simulate({**base, "sources": [base["source"]], "source": None})
    assert np.abs(a.astype(int) - b.astype(int)).mean() < 0.01


# ---- combine semantics ------------------------------------------------------
def test_merge_two_emitters_interact():
    fr = _frames(_graph("merge"))
    assert fr[-1][:, 28:36, :].mean() > 1.0  # dye meets in the middle band


def test_merge_differs_from_stack():
    diff = np.abs(
        _frames(_graph("merge")).astype(int) - _frames(_graph("stack")).astype(int)
    ).mean()
    assert diff > 1.0


def test_stack_opacity_dims_the_layer():
    full = _frames(_graph("stack", 1.0)).mean()
    dim = _frames(_graph("stack", 0.3)).mean()
    assert full > dim


@_needs_ffmpeg
def test_render_writes_mp4():
    url = G.render("job", SEG, _graph("merge"), NOAUDIO, OUT, "out1")
    assert url.endswith(".mp4")


@_needs_ffmpeg
def test_output_passthrough_renders():
    fa = _fluid("fA", (1, 1, 1), [0.4, 0.5], 0)
    fb = _fluid("fB", (0.3, 0.6, 1), [0.6, 0.5], 180)
    o1 = {"id": "o1", "type": "output", "x": 0, "y": 0, "data": {}}
    o2 = {"id": "o2", "type": "output", "x": 0, "y": 0, "data": {}}
    cb = _combine("stack")
    g = {
        "version": 1,
        "nodes": [fa, fb, cb, o1, o2],
        "edges": [
            _edge("fA", "o1", "video"),
            _edge("o1", "cb", "s0"),
            _edge("fB", "cb", "s1"),
            _edge("cb", "o2", "video"),
        ],
    }
    G.validate(g)  # no raise
    assert G.render("job", SEG, g, NOAUDIO, OUT, "o2").endswith(".mp4")


def test_stack_feeding_merge_rejected():
    fa = _fluid("fA", (1, 1, 1), [0.5, 0.5], 0)
    stack = {
        "id": "sc",
        "type": "combine",
        "x": 0,
        "y": 0,
        "data": {"mode": "stack", "inputs": [{"id": "a"}], "medium": {}},
    }
    merge = {
        "id": "mc",
        "type": "combine",
        "x": 0,
        "y": 0,
        "data": {"mode": "merge", "inputs": [{"id": "b"}], "medium": {}},
    }
    g = {
        "version": 1,
        "nodes": [fa, stack, merge, {"id": "out1", "type": "output", "x": 0, "y": 0, "data": {}}],
        "edges": [_edge("fA", "sc", "a"), _edge("sc", "mc", "b"), _edge("mc", "out1", "video")],
    }
    with pytest.raises(ValueError, match="merge"):
        G.validate(g)


def test_merge_respects_per_component_wrap():
    """In a merge, each component's dye keeps its own edge behaviour (wrap vs
    escape) while sharing one velocity field — so the result is order-independent
    (no longer 'first input wins') and sits between all-wrap and all-open."""

    def fl(nid, wrap):
        ports = {
            k: {"binding": {"kind": "const", "value": v}}
            for k, v in [
                ("force", 55),
                ("angle", 0),
                ("emit", 0.5),
                ("radius", 0.06),
                ("r", 1),
                ("g", 1),
                ("b", 1),
            ]
        }
        return {
            "id": nid,
            "type": "fluid",
            "x": 0,
            "y": 0,
            "data": {
                "static": {
                    "enabled": True,
                    "radial": False,
                    "wrap": wrap,
                    "points": [[0.15, 0.5]],
                    "path_speed": 1,
                    "path_closed": False,
                    "path_pingpong": False,
                    "intensity": 1.0,
                    "opacity": 1.0,
                    "color": [1, 1, 1],
                },
                "ports": ports,
            },
        }

    cbn = {
        "id": "cb",
        "type": "combine",
        "x": 0,
        "y": 0,
        "data": {"mode": "merge", "inputs": [{"id": "s0"}, {"id": "s1"}], "medium": {}},
    }
    out = {"id": "o", "type": "output", "x": 0, "y": 0, "data": {}}

    def mean(a_wrap, b_wrap, order=("A", "B")):
        g = {
            "version": 1,
            "nodes": [fl("A", a_wrap), fl("B", b_wrap), cbn, out],
            "edges": [
                _edge(order[0], "cb", "s0"),
                _edge(order[1], "cb", "s1"),
                _edge("cb", "o", "video"),
            ],
        }
        frames = G._Dag("job", SEG, g, NOAUDIO, OUT).video(G._video_source(g, "o", "video"))
        return float(frames.mean())

    ab = mean(True, False, ("A", "B"))
    ba = mean(True, False, ("B", "A"))
    assert abs(ab - ba) < 0.5  # order-independent (per-component)
    assert mean(False, False) - 1 <= ab <= mean(True, True) + 1  # between open & wrap


def test_output_hash_isolates_pipelines():
    g = _graph("merge")
    h1 = G.output_hash("job", SEG, g, "out1", OUT)
    g2 = _graph("stack", 0.4)
    assert G.output_hash("job", SEG, g2, "out1", OUT) != h1  # changing the combine busts it
