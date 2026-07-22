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

from helpers import no_audio as NOAUDIO
from backend import paths
from backend import song_render as SR

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
    # The graph rides on the seg dict only for the tests' own convenience (solo Dag
    # renders); build_plan reads it through the pool (`_pool`) like the app does.
    return {
        "id": sid,
        "start": start,
        "end": end,
        "signals": [],
        "graph": graph,
        "rootCompositionId": f"c-{sid}",
        "finalOutputId": oid,
    }


def _pool(segs):
    """The composition pool the segments reference (one root composition each)."""
    return {
        f"c-{s['id']}": {
            "id": f"c-{s['id']}",
            "name": s["id"],
            "graph": s["graph"],
            "outputId": s.get("finalOutputId"),
        }
        for s in segs
        if s.get("graph") is not None
    }


def _render(segs, export=EXPORT):
    ctx = SR.build_plan("job", segs, _pool(segs), [], export, NOAUDIO)
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
    segs = [_seg("s1", 0.0, 0.4, _fluid_out(0.6))]
    SR.render_song(
        "job",
        segs,
        _pool(segs),
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
    # No composition reference at all — the segment has no animation to render.
    segs = [{"id": "s1", "start": 0.0, "end": 1.0, "signals": []}]
    with pytest.raises(ValueError):
        SR.build_plan("job", segs, {}, [], EXPORT, NOAUDIO)

    # A composition with TWO outputs and no mark is genuinely ambiguous (a single
    # unmarked output resolves on its own — `final_output_id`'s sole-output fallback).
    two = _fluid_out(0.5)
    two["nodes"].append({"id": "o2", "type": "output", "data": {}})
    two["edges"].append(_edge("f1", "o2", "video"))
    segs = [_seg("s1", 0.0, 1.0, two, oid=None)]
    with pytest.raises(ValueError):
        SR.build_plan("job", segs, _pool(segs), [], EXPORT, NOAUDIO)


def test_each_segment_announces_itself_before_it_is_rendered():
    """`on_segment(i, n, label)` fires as a segment BEGINS — the only moment that knows it.

    The song render yields once per segment, so the frame counter sits still for minutes
    and then leaps a whole segment; a user reasonably read that as "stuck at 13s". The
    announcement has to come BEFORE the work, not with the yield, or it would arrive only
    once the long wait is already over.
    """
    segs = [_seg("s1", 0.0, 1.0, _fluid_out(0.6)), _seg("s2", 1.0, 2.0, _fluid_out(0.3))]
    ctx = SR.build_plan("job", segs, _pool(segs), [], EXPORT, NOAUDIO)
    seen = []
    windows = 0
    # noqa B023: the lambda is invoked SYNCHRONOUSLY inside the loop, so reading the
    # live `windows` is the point — binding it as a default would freeze it at 0.
    for _a, _b, _w in SR.iter_song_windows(
        ctx, on_segment=lambda *a: seen.append((a, windows))  # noqa: B023
    ):
        windows += 1
    # both segments named, numbered 1..n with the count, and each announced BEFORE its
    # window was produced (windows still 0 for the first, 1 for the second)
    assert [a[0] for a, _ in seen] == [1, 2]
    assert {a[1] for a, _ in seen} == {2}
    assert [w for _, w in seen] == [0, 1]
    assert [a[2] for a, _ in seen] == ["s1", "s2"]  # falls back to the id when unlabelled


def test_the_generator_stays_usable_without_the_callback():
    """It's optional — the tests that just concatenate windows must not have to care."""
    segs = [_seg("s1", 0.0, 1.0, _fluid_out(0.6))]
    ctx = SR.build_plan("job", segs, _pool(segs), [], EXPORT, NOAUDIO)
    assert len(list(SR.iter_song_windows(ctx))) == 1


def _backdrop_out(color="#204080"):
    """A sim-FREE segment: nothing for the continuous fields to inject."""
    return {
        "version": 1,
        "nodes": [
            {"id": "b", "type": "backdrop", "data": {"color": color, "ports": {}}},
            {"id": "o", "type": "output", "data": {}},
        ],
        "edges": [_edge("b", "o", "video")],
    }


def test_a_sim_free_segment_is_streamed_not_held_whole():
    """The whole-clip path renders at the DAG's own frame size, which for a sim-free graph
    is the export's NATIVE size — a 60 s segment at 2160x3840 RGBA is ~59 GB in ONE
    allocation. A real 4K export sat at 13-17 GB resident until the OS memory killer took
    it. A segment with no field to inject has no reason to be held whole: it streams."""
    # Longer than one block: hd_block_seconds caps at 5 s, so a 12 s segment must split.
    segs = [_seg("s1", 0.0, 12.0, _backdrop_out())]
    ctx = SR.build_plan("job", segs, _pool(segs), [], EXPORT, NOAUDIO)
    windows = list(SR.iter_song_windows(ctx))
    assert len(windows) > 1, "a sim-free segment still renders as one whole-clip window"
    biggest = max(w.shape[0] for _a, _b, w in windows)
    assert biggest < ctx["total"], "one window still covers the whole segment"
    # Consecutive, gapless, and covering exactly the segment.
    assert windows[0][0] == 0 and windows[-1][1] == ctx["total"]
    assert all(b == windows[i + 1][0] for i, (_a, b, _w) in enumerate(windows[:-1]))
    assert sum(w.shape[0] for _a, _b, w in windows) == ctx["total"]


def test_streaming_a_sim_free_segment_renders_the_same_pixels():
    """The lockstep invariant, applied to the change: streamed must equal whole-clip.
    Compared after `flatten`, because the streamed blocks stay RGBA (the encoder
    composites them over black) while the fluid path yields flattened RGB."""
    from backend import fluid as F

    segs = [_seg("s1", 0.0, 2.0, _backdrop_out("#3a7f2b"))]
    ctx = SR.build_plan("job", segs, _pool(segs), [], EXPORT, NOAUDIO)
    streamed = np.concatenate([F.flatten(w) for _a, _b, w in SR.iter_song_windows(ctx)], axis=0)

    dag, oid = ctx["plan"][0][0], ctx["plan"][0][1]
    whole = F.flatten(dag.video(oid))
    assert streamed.shape == whole.shape
    assert np.array_equal(streamed, whole), "streaming changed the picture"


def test_a_mixed_song_keeps_both_paths_and_stays_gapless():
    """A song can mix a fluid segment (held whole, RGB) with a sim-free one (streamed,
    RGBA). The frame ranges must still tile the song exactly, in order."""
    segs = [_seg("s1", 0.0, 1.0, _fluid_out(0.6)), _seg("s2", 1.0, 3.0, _backdrop_out())]
    ctx = SR.build_plan("job", segs, _pool(segs), [], EXPORT, NOAUDIO)
    windows = list(SR.iter_song_windows(ctx))
    assert windows[0][2].shape[-1] == 3  # the fluid segment: one flattened window
    assert any(w.shape[-1] == 4 for _a, _b, w in windows[1:])  # the streamed one: RGBA
    at = 0
    for a, b, w in windows:
        assert a == at and b - a == w.shape[0]
        at = b
    assert at == ctx["total"]


def test_export_hash_folds_the_root_composition():
    """The export key must move when a segment's root composition is edited — the
    graphs live in the pool now, so hashing the segment list alone would serve a
    stale master after any animation edit."""
    segs = [_seg("s1", 0.0, 1.0, _fluid_out(0.5))]
    pool = _pool(segs)
    base = SR._export_hash("job", segs, pool, [], EXPORT)

    edited = _pool(segs)
    edited["c-s1"]["graph"]["nodes"][0]["data"]["static"]["points"] = [[0.1, 0.1]]
    assert SR._export_hash("job", segs, edited, [], EXPORT) != base

    # …and re-pointing the segment at a different composition moves it too.
    repointed = [{**segs[0], "rootCompositionId": "c-other"}]
    other = {"c-other": {**pool["c-s1"], "id": "c-other"}}
    assert SR._export_hash("job", repointed, other, [], EXPORT) != base


def _leaf_backdrop(cid, color):
    return {
        "id": cid,
        "name": cid,
        "graph": {
            "version": 30,
            "nodes": [
                {"id": "b", "type": "backdrop", "data": {"color": color, "ports": {}}},
                {"id": f"{cid}-o", "type": "output", "data": {}},
            ],
            "edges": [_edge("b", f"{cid}-o", "video")],
        },
    }


def _montage_root(*comp_ids, manual=()):
    """A root graph: montage(extracts → comp_ids, manual cuts) → output."""
    return {
        "version": 30,
        "nodes": [
            {
                "id": "mg",
                "type": "montage",
                "data": {
                    "extracts": [
                        {"id": f"x{i}", "compositionId": cid} for i, cid in enumerate(comp_ids)
                    ],
                    "manualBreakpoints": [{"id": f"bp{i}", "t": t} for i, t in enumerate(manual)],
                    "disabledCuts": [],
                    "threshold": 0.5,
                    "hysteresis": 0.1,
                    "ports": {},
                },
            },
            {"id": "o", "type": "output", "data": {}},
        ],
        "edges": [_edge("mg", "o", "video")],
    }


def test_song_export_unrolls_a_montage_root(tmp_path, monkeypatch):
    """End to end over the DAG: segment 2's root is a montage of two backdrop-leaf
    compositions cut by a manual breakpoint — the export streams it (sim-free root),
    stays gapless, and shows each child on its own side of the cut."""
    monkeypatch.setattr(paths, "ASSETS_DIR", tmp_path)  # nothing decodes, but be tidy
    segs = [
        _seg("s1", 0.0, 1.0, _fluid_out(0.6)),
        {
            "id": "s2",
            "start": 1.0,
            "end": 2.0,
            "signals": [],
            "rootCompositionId": "c-root",
        },
    ]
    pool = _pool(segs[:1])
    pool["c-root"] = {
        "id": "c-root",
        "name": "s2",
        "graph": _montage_root("ca", "cb", manual=(0.5,)),
    }
    pool["ca"] = _leaf_backdrop("ca", "#ff0000")
    pool["cb"] = _leaf_backdrop("cb", "#0000ff")

    ctx = SR.build_plan("job", segs, pool, [], EXPORT, NOAUDIO)
    windows = list(SR.iter_song_windows(ctx))
    at = 0
    for a, b, w in windows:  # gapless, in order
        assert a == at and b - a == w.shape[0]
        at = b
    assert at == ctx["total"]
    # Segment 2 streams RGBA (sim-free root); its frames flip red→blue at the cut.
    s2 = np.concatenate([w for a, b, w in windows if w.shape[-1] == 4], axis=0)
    fps = EXPORT["fps"]
    assert s2.shape[0] == fps  # the 1s window
    mid_y, mid_x = s2.shape[1] // 2, s2.shape[2] // 2
    assert s2[0, mid_y, mid_x, 0] > 200 and s2[0, mid_y, mid_x, 2] < 60  # red first
    cut = round(0.5 * fps)
    assert s2[cut, mid_y, mid_x, 2] > 200 and s2[cut, mid_y, mid_x, 0] < 60  # blue after


def test_layer_continuity_stops_at_the_root_composition():
    """The pinned rule: persistent-field (`layer`) continuity applies ONLY to fluids
    in a segment's ROOT composition graph. A fluid inside a montage CHILD re-simulates
    on the extract's local clock — segment 1's dye does NOT carry into it."""
    child_fluid = {
        "id": "cf",
        "name": "cf",
        "graph": {
            "version": 30,
            "nodes": [
                _fluid("f2", 0.0),  # emits nothing — only inherited dye could show
                {"id": "cf-o", "type": "output", "data": {}},
            ],
            "edges": [_edge("f2", "cf-o", "video")],
        },
    }
    segs = [
        _seg("s1", 0.0, 1.0, _fluid_out(0.6)),  # layer 1 emits for a second
        {"id": "s2", "start": 1.0, "end": 2.0, "signals": [], "rootCompositionId": "c-root"},
    ]
    pool = _pool(segs[:1])
    pool["c-root"] = {"id": "c-root", "name": "s2", "graph": _montage_root("cf")}
    pool["cf"] = child_fluid

    ctx = SR.build_plan("job", segs, pool, [], EXPORT, NOAUDIO)
    frames = [w for _a, _b, w in SR.iter_song_windows(ctx)]
    total = sum(f.shape[0] for f in frames)
    assert total == ctx["total"]
    # The child's fluid started from a BLANK field: nothing carried across the
    # boundary (compare test_field_carries_across_boundary, where the same emit-0
    # fluid in the ROOT graph inherits segment 1's dye).
    s2_first = frames[-1][0] if frames[-1].shape[0] else frames[-1]
    assert float(s2_first[..., :3].mean()) < 1.0
