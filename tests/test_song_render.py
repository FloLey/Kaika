"""Continuous whole-song export (song_render).

The defining property is that the fluid FIELD carries across segment boundaries while
the rules switch: a segment that emits nothing still shows the previous segment's
advecting dye. We assert that at the frame level via `iter_song_windows` (no ffmpeg),
plus layer-number continuity, per-segment styling, and the frame/grid bookkeeping.
"""

from __future__ import annotations

import shutil

import numpy as np
import pytest

from backend import graph as G
from backend import paths
from backend import song_render as SR

NOAUDIO = lambda j, s: None  # noqa: E731
EXPORT = {"width": 64, "height": 96, "fps": 20, "gridCells": 32, "background": "#000000"}


def _fluid(nid, emit, rgb=(1.0, 0.3, 0.2), layer=None):
    ports = {
        k: {"binding": {"kind": "const", "value": v}}
        for k, v in [
            ("emit", emit),
            ("force", 40),
            ("radius", 0.12),
            ("r", rgb[0]),
            ("g", rgb[1]),
            ("b", rgb[2]),
        ]
    }
    data = {"static": {"points": [[0.5, 0.5]], "wrap": True}, "ports": ports}
    if layer is not None:
        data["layer"] = layer
    return {"id": nid, "type": "fluid", "data": data}


def _edge(s, t, tp):
    return {"id": s + t + tp, "source": s, "sourcePort": "out", "target": t, "targetPort": tp}


def _fluid_out(emit, rgb=(1.0, 0.3, 0.2)):
    return {
        "version": 1,
        "nodes": [_fluid("f1", emit, rgb), {"id": "o", "type": "output", "data": {}}],
        "edges": [_edge("f1", "o", "video")],
    }


def _seg(sid, start, end, graph, oid="o"):
    return {
        "id": sid,
        "start": start,
        "end": end,
        "signals": [],
        "graph": graph,
        "finalOutputId": oid,
    }


def _render(segs, export=EXPORT):
    ctx = SR.build_plan("job", segs, [], export, NOAUDIO)
    frames = np.concatenate([w for _a, _b, w in SR.iter_song_windows(ctx)], axis=0)
    return ctx, frames


def test_field_carries_across_boundary():
    # seg1 emits dye; seg2 emits NOTHING. One layer -> seg2 must inherit seg1's field.
    segs = [_seg("s1", 0.0, 1.0, _fluid_out(0.6)), _seg("s2", 1.0, 2.0, _fluid_out(0.0))]
    ctx, frames = _render(segs)
    w1 = ctx["plan"][0][3]  # seg1 window length
    assert frames.shape[0] == ctx["total"]
    assert frames[w1 + 1].mean() > 5.0  # seg2's opening still has advected dye (carried)

    # Control: seg2 rendered ALONE starts from a blank field -> ~black.
    dag = G.Dag(
        "job",
        {**segs[1], "lyric_lines": []},
        segs[1]["graph"],
        NOAUDIO,
        {**EXPORT, "quality": "draft"},
    )
    solo = G.fluid.flatten(dag.video("o"))
    assert solo[1].mean() < 1.0


def test_grid_and_frame_count_from_export():
    segs = [_seg("s1", 0.0, 1.0, _fluid_out(0.5)), _seg("s2", 1.0, 2.5, _fluid_out(0.5))]
    ctx, frames = _render(segs)
    gh, gw = G.fluid.grid_for(EXPORT["width"], EXPORT["height"], EXPORT["gridCells"])
    assert frames.shape[1:] == (gh, gw, 3)
    assert frames.shape[0] == round(1.0 * 20) + round(1.5 * 20)  # sum of per-segment windows


def test_layer_number_controls_continuity():
    # seg1 emits on layer 1. A seg2 that reuses layer 1 (emit 0) inherits the field;
    # a seg2 that uses a DIFFERENT layer number gets a fresh, blank field. The layer
    # NUMBER is the continuity key.
    def seg2_on(layer):
        g = _fluid_out(0.0)
        g["nodes"][0]["data"]["layer"] = layer
        return g

    _, matched = _render([_seg("s1", 0.0, 1.0, _fluid_out(0.6)), _seg("s2", 1.0, 2.0, seg2_on(1))])
    _, mismatched = _render(
        [_seg("s1", 0.0, 1.0, _fluid_out(0.6)), _seg("s2", 1.0, 2.0, seg2_on(9))]
    )
    w1 = round(1.0 * EXPORT["fps"])
    assert matched[w1 + 1].mean() > 5.0  # layer 1 continued
    assert mismatched[w1 + 1].mean() < 1.0  # layer 9 is a fresh field -> blank


def test_per_segment_styling_is_applied():
    # The same continuous field, styled by two segment downstreams: a stack combine that
    # dims the layer (opacity 0.3) must change the frames vs the plain pass-through.
    dimmed = {
        "version": 1,
        "nodes": [
            _fluid("f1", 0.6),
            {
                "id": "cb",
                "type": "combine",
                "data": {"mode": "stack", "inputs": [{"id": "s0", "opacity": 0.3}]},
            },
            {"id": "o", "type": "output", "data": {}},
        ],
        "edges": [_edge("f1", "cb", "s0"), _edge("cb", "o", "video")],
    }
    _, plain = _render([_seg("s1", 0.0, 1.0, _fluid_out(0.6))])
    _, styled = _render([_seg("s1", 0.0, 1.0, dimmed)])
    assert plain.shape == styled.shape
    assert not np.array_equal(plain, styled)  # the segment's own composite was applied
    assert styled.mean() < plain.mean()  # opacity 0.3 dimmed it


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_progress_preview_url_is_servable(tmp_path, monkeypatch):
    # The scratch id lands in the progress preview URL, and /fluid/stream/<id>/… only
    # serves alnum ids — so `song_<hash>` (underscore) made every export preview 404.
    monkeypatch.setattr(paths, "ANIM_DIR", tmp_path / "fluid")
    monkeypatch.setattr(paths, "STREAM_DIR", tmp_path / "fluid" / "stream")
    (tmp_path / "fluid").mkdir()

    urls: list[str] = []
    SR.render_song(
        "job",
        [_seg("s1", 0.0, 0.4, _fluid_out(0.6))],
        [],
        EXPORT,
        NOAUDIO,
        on_progress=lambda done, total, url: urls.append(url),
    )

    previews = [u for u in urls if u.startswith("/fluid/stream/")]
    assert previews, "the export reported no in-progress preview URL"
    for u in previews:
        render_id = u.split("/")[3]
        assert render_id.isalnum(), f"unservable stream id: {render_id!r}"


def test_build_plan_rejects_unmarked_segment():
    segs = [
        {"id": "s1", "start": 0.0, "end": 1.0, "signals": [], "graph": _fluid_out(0.5)}
    ]  # no finalOutputId
    with pytest.raises(ValueError):
        SR.build_plan("job", segs, [], EXPORT, NOAUDIO)
