"""The `transform` video-FX card (video -> video): affine warp + mirror/kaleidoscope folds.

Its two invariants are the ones every video handler carries: the whole-clip path and the
block-streaming path must produce IDENTICAL frames (streaming changes when you see a
frame, never which), and the dye-on-black floor must survive — sampling outside the frame
yields 0, so downstream compositing/backdrops stay correct. It is not an emitter source,
so a merge combine must reject it.
"""

from __future__ import annotations

import numpy as np
import pytest

from backend import graph as G
from backend import graph_render as GR

NOAUDIO = lambda j, s: None  # noqa: E731
SEG = {"start": 0.0, "end": 1.0, "signals": [], "lyric_lines": []}
OUT = {"width": 64, "height": 64, "quality": "draft", "fps": 10}
PARAMS = ("zoom", "rotate", "pan_x", "pan_y")


def _arr(v, n=3):
    return np.full(n, v, np.float32)


def _fluid(nid="f1"):
    ports = {
        k: {"binding": {"kind": "const", "value": v}}
        for k, v in [
            ("emit", 0.6),
            ("force", 40),
            ("radius", 0.12),
            ("r", 1.0),
            ("g", 0.3),
            ("b", 0.2),
        ]
    }
    return {
        "id": nid,
        "type": "fluid",
        "data": {"static": {"points": [[0.35, 0.35]], "wrap": True}, "ports": ports},
    }


def _transform(nid="t1", mode="kaleidoscope", **ports):
    p = {k: {"binding": {"kind": "const", "value": v}} for k, v in ports.items()}
    return {
        "id": nid,
        "type": "transform",
        "data": {"mode": mode, "segments": 6, "wrap": False, "ports": p},
    }


def _edge(s, t, tp):
    return {"id": s + t + tp, "source": s, "sourcePort": "out", "target": t, "targetPort": tp}


def _graph(mode="kaleidoscope", **ports):
    return {
        "version": 21,
        "nodes": [
            _fluid(),
            _transform(mode=mode, **ports),
            {"id": "o", "type": "output", "data": {}},
        ],
        "edges": [_edge("f1", "t1", "video"), _edge("t1", "o", "video")],
    }


# --------------------------------------------------------------------------- #
# The lockstep invariant: whole-clip == block-streamed, frame for frame.
# --------------------------------------------------------------------------- #
def test_whole_clip_and_block_stream_are_identical():
    graph = _graph(rotate=45.0, zoom=1.2)
    whole = G.fluid.flatten(G._Dag("job", SEG, graph, NOAUDIO, OUT).video("o"))
    dag = G._Dag("job", SEG, graph, NOAUDIO, OUT)
    streamed = np.concatenate(
        [G.fluid.flatten(b) for _a, _b, _t, b in dag.stream_blocks("o", 4)], axis=0
    )
    assert streamed.shape == whole.shape
    assert np.array_equal(whole, streamed)


def test_transform_actually_changes_the_frames():
    plain = G.fluid.flatten(G._Dag("job", SEG, _graph_passthrough(), NOAUDIO, OUT).video("o"))
    warped = G.fluid.flatten(G._Dag("job", SEG, _graph(rotate=90.0), NOAUDIO, OUT).video("o"))
    assert plain.shape == warped.shape
    assert not np.array_equal(plain, warped)


def _graph_passthrough():
    return {
        "version": 21,
        "nodes": [_fluid(), {"id": "o", "type": "output", "data": {}}],
        "edges": [_edge("f1", "o", "video")],
    }


# --------------------------------------------------------------------------- #
# The black floor: an all-black clip stays all-black through every mode.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("mode", ["transform", "mirror", "kaleidoscope"])
@pytest.mark.parametrize("wrap", [False, True])
def test_black_stays_black(mode, wrap):
    black = np.zeros((3, 32, 40, 3), np.uint8)
    out = GR._transform_frames(
        black, mode, 6, wrap, zoom=_arr(1.3), rotate=_arr(33.0), pan_x=_arr(0.2), pan_y=_arr(-0.1)
    )
    assert out.shape == black.shape and out.max() == 0


# --------------------------------------------------------------------------- #
# No black gaps: on a NON-SQUARE frame the fold reaches past the short side, so it
# must MIRROR the edge (not sample black) — content everywhere, at any rotation.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("mode", ["mirror", "kaleidoscope"])
def test_fold_modes_have_no_black_gaps_on_a_non_square_frame(mode):
    solid = np.full((2, 8, 16, 3), 100, np.uint8)  # landscape, fully non-black
    rotate = np.array([0.0, 37.0], np.float32)  # a straight + a rotated frame
    out = GR._transform_frames(
        solid,
        mode,
        6,
        False,
        zoom=_arr(1.0, 2),
        rotate=rotate,
        pan_x=_arr(0.0, 2),
        pan_y=_arr(0.0, 2),
    )
    assert out.shape == solid.shape
    assert out.min() > 0  # every pixel sampled real content — no black wedges/corners


def test_plain_transform_still_shows_black_corners_on_rotate():
    # The conventional pan/zoom/rotate look is unchanged: rotating a non-square frame
    # still reveals black outside (unless `wrap`).
    solid = np.full((1, 8, 16, 3), 100, np.uint8)
    out = GR._transform_frames(
        solid,
        "transform",
        6,
        False,
        zoom=_arr(1.0, 1),
        rotate=_arr(37.0, 1),
        pan_x=_arr(0.0, 1),
        pan_y=_arr(0.0, 1),
    )
    assert out.min() == 0  # black corners on rotate (cval=0), as before


def test_identity_params_are_a_no_op():
    img = (np.random.default_rng(0).random((2, 24, 24, 3)) * 255).astype(np.uint8)
    out = GR._transform_frames(
        img,
        "transform",
        6,
        False,
        zoom=_arr(1.0, 2),
        rotate=_arr(0.0, 2),
        pan_x=_arr(0.0, 2),
        pan_y=_arr(0.0, 2),
    )
    assert np.array_equal(out, img)


def test_rgba_alpha_warps_with_the_colour():
    # A lyrics layer is (T, H, W, 4): its alpha must be warped too, or the glyph
    # cut-out would drift away from the pixels it masks.
    rgba = np.zeros((1, 16, 16, 4), np.uint8)
    rgba[0, 4:12, 4:12] = 200
    out = GR._transform_frames(
        rgba,
        "transform",
        6,
        False,
        zoom=_arr(2.0, 1),
        rotate=_arr(0.0, 1),
        pan_x=_arr(0.0, 1),
        pan_y=_arr(0.0, 1),
    )
    assert out.shape == rgba.shape
    assert (out[0, :, :, 3] > 0).sum() > (rgba[0, :, :, 3] > 0).sum()  # zoomed in


def test_static_fields_are_coerced():
    # A junk mode falls back to the plain affine; segments clamp into 2..12.
    assert GR._transform_static({"mode": "nope"})[0] == "transform"
    assert GR._transform_static({"segments": 99})[1] == 12
    assert GR._transform_static({"segments": 0})[1] == 2
    assert GR._transform_static({})[:2] == ("transform", 6)


# --------------------------------------------------------------------------- #
# Wiring: an FX card produces frames, not emitters — a merge combine must refuse it.
# --------------------------------------------------------------------------- #
def test_transform_cannot_feed_a_merge_combine():
    graph = {
        "version": 21,
        "nodes": [
            _fluid(),
            _transform(),
            {"id": "cb", "type": "combine", "data": {"mode": "merge", "inputs": [{"id": "s0"}]}},
            {"id": "o", "type": "output", "data": {}},
        ],
        "edges": [_edge("f1", "t1", "video"), _edge("t1", "cb", "s0"), _edge("cb", "o", "video")],
    }
    with pytest.raises(ValueError):
        G.validate(graph)


def test_transform_feeds_a_stack_combine_and_an_output():
    stack = {
        "version": 21,
        "nodes": [
            _fluid(),
            _transform(),
            {
                "id": "cb",
                "type": "combine",
                "data": {"mode": "stack", "inputs": [{"id": "s0", "opacity": 1.0}]},
            },
            {"id": "o", "type": "output", "data": {}},
        ],
        "edges": [_edge("f1", "t1", "video"), _edge("t1", "cb", "s0"), _edge("cb", "o", "video")],
    }
    G.validate(stack)  # must not raise
    G.validate(_graph())


def test_transform_without_a_video_input_raises():
    graph = {
        "version": 21,
        "nodes": [_transform(), {"id": "o", "type": "output", "data": {}}],
        "edges": [_edge("t1", "o", "video")],
    }
    with pytest.raises(ValueError):
        G.render("job", SEG, graph, NOAUDIO, OUT)


# --------------------------------------------------------------------------- #
# The render cache key covers the card, and is stable for static params.
# --------------------------------------------------------------------------- #
def test_output_hash_is_stable_and_mode_sensitive():
    a = G.output_hash("job", SEG, _graph(rotate=45.0), "o", OUT)
    b = G.output_hash("job", SEG, _graph(rotate=45.0), "o", OUT)
    assert a == b  # a static-param transform graph hits the cache on a second render
    assert a != G.output_hash("job", SEG, _graph(rotate=90.0), "o", OUT)
    assert a != G.output_hash("job", SEG, _graph(mode="mirror", rotate=45.0), "o", OUT)


# --------------------------------------------------------------------------- #
# The whole-song export walks through the FX chain to the fluid field beneath it.
# --------------------------------------------------------------------------- #
def test_field_nodes_sees_through_a_transform():
    from backend.graph_common import _field_nodes

    assert _field_nodes(_graph(), "o") == ["f1"]
