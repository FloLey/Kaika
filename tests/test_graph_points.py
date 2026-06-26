"""Points source card: a fluid emits one source per drawn point, sharing its
params (spec 11). Const-only fluids need no audio. Small grids keep it fast."""

from __future__ import annotations

import numpy as np

from backend import graph as G

OUT = {"width": 96, "height": 96, "quality": "draft", "fps": 24, "background": "#000000"}
SEG = {"start": 0.0, "end": 1.5, "signals": []}
NOAUDIO = lambda j, s: None  # noqa: E731


def _fluid(nid="f"):
    ports = {
        k: {"binding": {"kind": "const", "value": v}}
        for k, v in [("force", 0), ("emit", 0.5), ("radius", 0.05), ("r", 1), ("g", 1), ("b", 1)]
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
                "points": [[0.5, 0.5]],
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


def _edge(s, t, tp):
    return {
        "id": f"e-{s}-{t}-{tp}",
        "source": s,
        "sourcePort": "out",
        "target": t,
        "targetPort": tp,
    }


def _render(g):
    dag = G._Dag("job", SEG, g, NOAUDIO, OUT)
    return dag.video(G._video_source(g, "o", "video"))


def _band(frames, x):
    w = frames.shape[2]
    c = int(x * w)
    return float(frames[-1, :, max(0, c - 4) : c + 4, :].mean())


def test_one_source_per_point():
    f = _fluid()
    pts = {
        "id": "p",
        "type": "points",
        "x": 0,
        "y": 0,
        "data": {"points": [[0.25, 0.5], [0.5, 0.5], [0.75, 0.5]]},
    }
    out = {"id": "o", "type": "output", "x": 0, "y": 0, "data": {}}
    g = {
        "version": 1,
        "nodes": [f, pts, out],
        "edges": [_edge("p", "f", "positions"), _edge("f", "o", "video")],
    }
    fr = _render(g)
    # all three columns lit
    assert min(_band(fr, x) for x in (0.25, 0.5, 0.75)) > 5.0


def test_no_points_is_single_centre_source():
    f = _fluid()
    out = {"id": "o", "type": "output", "x": 0, "y": 0, "data": {}}
    g = {"version": 1, "nodes": [f, out], "edges": [_edge("f", "o", "video")]}
    fr = _render(g)
    # centre lit, sides dark (one source only)
    assert _band(fr, 0.5) > 5.0
    assert _band(fr, 0.2) < 1.0 and _band(fr, 0.8) < 1.0
    # and the executor reports a single emitter
    assert len(G._Dag("job", SEG, g, NOAUDIO, OUT).emitters("f")) == 1


def test_points_fluid_into_merge_contributes_n_emitters():
    f = _fluid()
    pts = {
        "id": "p",
        "type": "points",
        "x": 0,
        "y": 0,
        "data": {"points": [[0.2, 0.5], [0.8, 0.5]]},
    }
    cb = {
        "id": "cb",
        "type": "combine",
        "x": 0,
        "y": 0,
        "data": {"mode": "merge", "inputs": [{"id": "s0"}], "medium": {}},
    }
    out = {"id": "o", "type": "output", "x": 0, "y": 0, "data": {}}
    g = {
        "version": 1,
        "nodes": [f, pts, cb, out],
        "edges": [_edge("p", "f", "positions"), _edge("f", "cb", "s0"), _edge("cb", "o", "video")],
    }
    assert len(G._Dag("job", SEG, g, NOAUDIO, OUT).emitters("cb")) == 2


def test_moving_a_point_busts_the_output_hash():
    f = _fluid()
    pts = {"id": "p", "type": "points", "x": 0, "y": 0, "data": {"points": [[0.3, 0.5]]}}
    out = {"id": "o", "type": "output", "x": 0, "y": 0, "data": {}}
    g = {
        "version": 1,
        "nodes": [f, pts, out],
        "edges": [_edge("p", "f", "positions"), _edge("f", "o", "video")],
    }
    h1 = G.output_hash("job", SEG, g, "o", OUT)
    g2 = {**g, "nodes": [f, {**pts, "data": {"points": [[0.7, 0.5]]}}, out]}
    assert G.output_hash("job", SEG, g2, "o", OUT) != h1
