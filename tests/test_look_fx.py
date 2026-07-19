"""The look-FX cards (specs/look-fx/): echo (motion trails).

Echo is the wave's one STATEFUL effect — a decayed accumulator carried across
stream blocks — so the invariant that matters most here is stream ≡ sync: the
whole-clip path and the block-streamed path must produce IDENTICAL frames, state
handoff included (a modulated length switching on mid-clip must see the same
accumulator either way). Plus the FX-card basics: the dye-on-black floor
survives, length=0 is a bit-exact passthrough, and RGBA alpha trails along.
"""

from __future__ import annotations

import numpy as np

from backend import graph as G
from backend import look_fx

NOAUDIO = lambda j, s: None  # noqa: E731
SEG = {"start": 0.0, "end": 1.0, "signals": [], "lyric_lines": []}
OUT = {"width": 64, "height": 64, "quality": "draft", "fps": 10}


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


def _echo(nid="e1", mode="bright", **ports):
    p = {k: {"binding": {"kind": "const", "value": v}} for k, v in ports.items()}
    return {"id": nid, "type": "echo", "data": {"mode": mode, "ports": p}}


def _edge(s, t, tp):
    return {"id": s + t + tp, "source": s, "sourcePort": "out", "target": t, "targetPort": tp}


def _graph(mode="bright", **ports):
    return {
        "version": 24,
        "nodes": [_fluid(), _echo(mode=mode, **ports), {"id": "o", "type": "output", "data": {}}],
        "edges": [_edge("f1", "e1", "video"), _edge("e1", "o", "video")],
    }


def _arr(v, n):
    return np.full(n, v, np.float32)


# --------------------------------------------------------------------------- #
# The lockstep invariant: whole-clip == block-streamed, accumulator handoff included.
# --------------------------------------------------------------------------- #
def test_whole_clip_and_block_stream_are_identical():
    graph = _graph(length=0.5, amount=1.0)
    whole = G.fluid.flatten(G.Dag("job", SEG, graph, NOAUDIO, OUT).video("o"))
    dag = G.Dag("job", SEG, graph, NOAUDIO, OUT)
    streamed = np.concatenate(
        [G.fluid.flatten(b) for _a, _b, _t, b in dag.stream_blocks("o", 4)], axis=0
    )
    assert streamed.shape == whole.shape
    assert np.array_equal(whole, streamed)


def test_stream_matches_sync_when_length_switches_on_mid_clip():
    """A length=0 block must hand the NEXT block the same accumulator the full scan
    carries (the block-path fast-exit returns the block's last frame, not None)."""
    n = 10
    rng = np.random.default_rng(7)
    frames = (rng.random((n, 6, 6, 3)) * 255).astype(np.uint8)
    length = np.concatenate([_arr(0.0, 4), _arr(0.8, n - 4)])
    amount = _arr(1.0, n)
    whole, _ = look_fx.echo_scan(frames, None, 10, "bright", length=length, amount=amount)
    acc = None
    parts = []
    for a in range(0, n, 4):
        b = min(a + 4, n)
        out, acc = look_fx.echo_scan(
            frames[a:b], acc, 10, "bright", length=length[a:b], amount=amount[a:b]
        )
        parts.append(out)
    assert np.array_equal(whole, np.concatenate(parts))


# --------------------------------------------------------------------------- #
# The effect itself: ghosts linger and fade; the controls do what they say.
# --------------------------------------------------------------------------- #
def test_a_flash_leaves_a_monotonically_fading_trail():
    n = 8
    frames = np.zeros((n, 4, 4, 3), np.uint8)
    frames[0] = 200  # one bright frame, then darkness
    out, _ = look_fx.echo_scan(frames, None, 10, "bright", length=_arr(0.3, n), amount=_arr(1.0, n))
    trail = out[1:, 0, 0, 0].astype(int)
    assert trail[0] > 0  # the ghost exists...
    assert all(a > b for a, b in zip(trail, trail[1:]))  # ...and only ever fades
    assert np.array_equal(out[0], frames[0])  # the flash itself is untouched


def test_echo_actually_changes_a_moving_clip():
    plain = G.fluid.flatten(G.Dag("job", SEG, _graph(length=0.0), NOAUDIO, OUT).video("o"))
    trailed = G.fluid.flatten(G.Dag("job", SEG, _graph(length=0.8), NOAUDIO, OUT).video("o"))
    assert plain.shape == trailed.shape
    assert not np.array_equal(plain, trailed)
    # trails only ADD light on top of the dry frame, never remove it
    assert np.all(trailed.astype(int) >= plain.astype(int))


def test_length_zero_is_a_bitexact_passthrough():
    n = 6
    frames = (np.random.default_rng(3).random((n, 5, 5, 3)) * 255).astype(np.uint8)
    out, _ = look_fx.echo_scan(frames, None, 10, length=_arr(0.0, n), amount=_arr(1.0, n))
    assert out is frames  # the fast path doesn't even copy


def test_amount_zero_keeps_the_dry_frames():
    n = 6
    frames = np.zeros((n, 4, 4, 3), np.uint8)
    frames[0] = 200
    out, _ = look_fx.echo_scan(frames, None, 10, length=_arr(1.0, n), amount=_arr(0.0, n))
    assert np.array_equal(out, frames)


def test_black_floor_survives():
    n = 6
    frames = np.zeros((n, 4, 4, 3), np.uint8)
    out, _ = look_fx.echo_scan(frames, None, 10, "bright", length=_arr(1.0, n), amount=_arr(1.0, n))
    assert out.max() == 0


def test_rgba_alpha_trails_along():
    n = 6
    frames = np.zeros((n, 4, 4, 4), np.uint8)
    frames[0] = 200  # colour AND alpha flash once
    out, _ = look_fx.echo_scan(frames, None, 10, "bright", length=_arr(0.3, n), amount=_arr(1.0, n))
    assert out.shape[-1] == 4
    assert out[1, 0, 0, 3] > 0  # the ghost keeps a cut-out
    assert out[2, 0, 0, 3] < out[1, 0, 0, 3]  # and it fades too


# --------------------------------------------------------------------------- #
# Ghost mode: afterimages of every CHANGE, whatever the contrast.
# --------------------------------------------------------------------------- #
def test_ghost_trails_a_dark_subject_on_a_bright_background():
    """The running-man case: a dark square crossing a bright frame. Ghost mode leaves
    dark afterimages where the runner WAS; bright mode can't (its trail only ever adds
    light — it just washes the runner out with the remembered bright background)."""
    n, size = 8, 12
    frames = np.full((n, size, size, 3), 220, np.uint8)
    for i in range(n):
        frames[i, 4:8, i : i + 3] = 20  # the "runner" walks right, 1 px per frame
    ghost, _ = look_fx.echo_scan(
        frames, None, 10, "ghost", length=_arr(0.4, n), amount=_arr(1.0, n)
    )
    bright, _ = look_fx.echo_scan(
        frames, None, 10, "bright", length=_arr(0.4, n), amount=_arr(1.0, n)
    )
    # ghost: where the runner JUST was (now bright again), a dark afterimage lingers
    assert ghost[4, 5, 2, 0] < 200
    # bright: no dark afterimage anywhere — the trail only ever ADDS light
    assert np.all(bright.astype(int) >= frames.astype(int))
    # ...and the remembered background bleeds INTO the dark runner (washes it out)
    assert bright[4, 5, 5, 0] > 100


def test_ghost_first_frame_is_untouched():
    """An empty history must not dim the clip's first frame (acc seeds from frame 0)."""
    n = 5
    frames = (np.random.default_rng(11).random((n, 6, 6, 3)) * 255).astype(np.uint8)
    out, _ = look_fx.echo_scan(frames, None, 10, "ghost", length=_arr(0.5, n), amount=_arr(1.0, n))
    assert np.array_equal(out[0], frames[0])


def test_ghost_stream_matches_sync():
    n = 10
    frames = (np.random.default_rng(5).random((n, 6, 6, 3)) * 255).astype(np.uint8)
    length, amount = _arr(0.6, n), _arr(0.8, n)
    whole, _ = look_fx.echo_scan(frames, None, 10, "ghost", length=length, amount=amount)
    acc, parts = None, []
    for a in range(0, n, 3):
        b = min(a + 3, n)
        out, acc = look_fx.echo_scan(
            frames[a:b], acc, 10, "ghost", length=length[a:b], amount=amount[a:b]
        )
        parts.append(out)
    assert np.array_equal(whole, np.concatenate(parts))


def test_ghost_whole_clip_and_block_stream_are_identical_through_the_dag():
    graph = _graph(mode="ghost", length=0.5, amount=1.0)
    whole = G.fluid.flatten(G.Dag("job", SEG, graph, NOAUDIO, OUT).video("o"))
    dag = G.Dag("job", SEG, graph, NOAUDIO, OUT)
    streamed = np.concatenate(
        [G.fluid.flatten(b) for _a, _b, _t, b in dag.stream_blocks("o", 4)], axis=0
    )
    assert np.array_equal(whole, streamed)


def test_ghost_and_bright_actually_differ_on_a_moving_clip():
    ghost = G.fluid.flatten(
        G.Dag("job", SEG, _graph(mode="ghost", length=0.8), NOAUDIO, OUT).video("o")
    )
    bright = G.fluid.flatten(
        G.Dag("job", SEG, _graph(mode="bright", length=0.8), NOAUDIO, OUT).video("o")
    )
    assert not np.array_equal(ghost, bright)


# --------------------------------------------------------------------------- #
# Dark mode: bright's mirror — shadow trails, solid subject.
# --------------------------------------------------------------------------- #
def test_dark_drags_a_shadow_trail_and_keeps_the_subject_solid():
    """The daylight running-man pick: the dark figure stays fully sharp (a shadow
    trail can only DARKEN pixels) and drags a fading shadow where it was."""
    n, size = 8, 12
    frames = np.full((n, size, size, 3), 220, np.uint8)
    for i in range(n):
        frames[i, 4:8, i : i + 3] = 20
    out, _ = look_fx.echo_scan(frames, None, 10, "dark", length=_arr(0.4, n), amount=_arr(1.0, n))
    # the subject itself is untouched (still exactly 20 where the runner is now)
    assert out[4, 5, 5, 0] == 20
    # a fading shadow lingers where the runner was
    assert out[4, 5, 2, 0] < 200
    # dark trails only ever REMOVE light
    assert np.all(out.astype(int) <= frames.astype(int))


def test_dark_stream_matches_sync():
    n = 10
    frames = (np.random.default_rng(9).random((n, 6, 6, 3)) * 255).astype(np.uint8)
    length, amount = _arr(0.5, n), _arr(1.0, n)
    whole, _ = look_fx.echo_scan(frames, None, 10, "dark", length=length, amount=amount)
    acc, parts = None, []
    for a in range(0, n, 4):
        b = min(a + 4, n)
        out, acc = look_fx.echo_scan(
            frames[a:b], acc, 10, "dark", length=length[a:b], amount=amount[a:b]
        )
        parts.append(out)
    assert np.array_equal(whole, np.concatenate(parts))


# --------------------------------------------------------------------------- #
# Color Grade: thermal / duotone / neon (+ the wired tint colour).
# --------------------------------------------------------------------------- #
def _colorgrade(nid="cg1", mode="duotone", **ports):
    p = {k: {"binding": {"kind": "const", "value": v}} for k, v in ports.items()}
    return {
        "id": nid,
        "type": "colorgrade",
        "data": {
            "mode": mode,
            "map": "turbo",
            "colorA": "#0b1030",
            "colorB": "#ff5ac8",
            "ports": p,
        },
    }


def _cg_graph(mode="duotone", tint_node=None, **ports):
    nodes = [_fluid(), _colorgrade(mode=mode, **ports), {"id": "o", "type": "output", "data": {}}]
    edges = [_edge("f1", "cg1", "video"), _edge("cg1", "o", "video")]
    if tint_node is not None:
        nodes.append(tint_node)
        edges.append(_edge(tint_node["id"], "cg1", "tint"))
    return {"version": 24, "nodes": nodes, "edges": edges}


def _gradient_color(nid="col1"):
    """A gradient colour card whose position is driven by an LFO — per-frame colour."""
    return [
        {
            "id": nid,
            "type": "color",
            "data": {
                "mode": "gradient",
                "stops": [{"t": 0.0, "color": "#ff0000"}, {"t": 1.0, "color": "#0000ff"}],
                "ports": {
                    "position": {
                        "binding": {"kind": "node", "nodeId": "lfo1", "lo": 0.0, "hi": 1.0}
                    }
                },
            },
        },
        {
            "id": "lfo1",
            "type": "lfo",
            "data": {"shape": "saw", "rateMode": "cycles", "rate": 1, "phase": 0, "duty": 0.5},
        },
    ]


def test_colorgrade_stream_matches_sync():
    graph = _cg_graph(mode="duotone", intensity=1.0, shift=0.3)
    whole = G.fluid.flatten(G.Dag("job", SEG, graph, NOAUDIO, OUT).video("o"))
    dag = G.Dag("job", SEG, graph, NOAUDIO, OUT)
    streamed = np.concatenate(
        [G.fluid.flatten(b) for _a, _b, _t, b in dag.stream_blocks("o", 4)], axis=0
    )
    assert np.array_equal(whole, streamed)


def test_colorgrade_wired_tint_overrides_the_swatch_and_sweeps():
    color_card, lfo = _gradient_color()
    graph = _cg_graph(mode="duotone", tint_node=color_card, intensity=1.0)
    graph["nodes"].append(lfo)
    graph["edges"].append(_edge("lfo1", "col1", "position"))
    swept = G.fluid.flatten(G.Dag("job", SEG, graph, NOAUDIO, OUT).video("o"))
    plain = G.fluid.flatten(
        G.Dag("job", SEG, _cg_graph(mode="duotone", intensity=1.0), NOAUDIO, OUT).video("o")
    )
    assert not np.array_equal(swept, plain)  # the tint changed the grade
    # the gradient position sweeps over the clip, so the graded colour CHANGES per
    # frame — compare the first and last frames' mean hue balance
    assert abs(int(swept[0, ..., 0].mean()) - int(swept[-1, ..., 0].mean())) > 2


def test_colorgrade_intensity_zero_is_dry_for_lut_modes():
    n = 6
    frames = (np.random.default_rng(2).random((n, 8, 8, 3)) * 255).astype(np.uint8)
    ca = np.array([0.0, 0.0, 0.2], np.float32)
    cb = np.tile(np.array([1.0, 0.4, 0.8], np.float32), (n, 1))
    zero = np.zeros(n, np.float32)
    for mode in ("thermal", "duotone"):
        out = look_fx.colorgrade_apply(
            frames, mode, "turbo", ca, cb, 10, 0, intensity=zero, shift=zero
        )
        assert np.array_equal(out, frames), f"{mode} intensity=0 should be dry"


def test_colorgrade_neon_keeps_black_black():
    n = 4
    frames = np.zeros((n, 16, 16, 3), np.uint8)
    ca = np.zeros(3, np.float32)
    cb = np.tile(np.array([1.0, 0.4, 0.8], np.float32), (n, 1))
    out = look_fx.colorgrade_apply(
        frames,
        "neon",
        "turbo",
        ca,
        cb,
        10,
        0,
        intensity=np.ones(n, np.float32),
        shift=np.zeros(n, np.float32),
    )
    assert out.max() == 0


def test_colorgrade_rgba_alpha_passes_through():
    n = 4
    frames = (np.random.default_rng(4).random((n, 8, 8, 4)) * 255).astype(np.uint8)
    ca = np.zeros(3, np.float32)
    cb = np.tile(np.array([1.0, 0.4, 0.8], np.float32), (n, 1))
    out = look_fx.colorgrade_apply(
        frames,
        "duotone",
        "turbo",
        ca,
        cb,
        10,
        0,
        intensity=np.ones(n, np.float32),
        shift=np.zeros(n, np.float32),
    )
    assert np.array_equal(out[..., 3], frames[..., 3])
