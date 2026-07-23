"""Unit tests for the lyrics source card.

Exercise the rasterizer (per-word reveal, timing), the render-path integration
(lyric lines ride in the segment payload), and that the render cache busts when the
lyrics change. Run with ``.venv/bin/python -m pytest``.
"""

import numpy as np

from backend import fluid, fonts, graph, sources


def _arr(t, v):
    return np.full(t, float(v), np.float32)


def test_bundled_fonts_available_and_default():
    keys = {f["key"] for f in fonts.list_fonts()}
    assert {"inter", "oswald", "bebasneue", "anton"} <= keys
    assert fonts.default_key() == "inter"
    assert fonts.font_path("oswald") and fonts.font_path("nope") is None


def test_lyrics_is_rgba_with_white_fill_and_opaque_black_outline():
    n = 2
    f = sources.lyrics(
        n,
        128,
        96,
        8,
        lines=[{"t0": 0, "t1": 2, "text": "AB"}],
        seg_start=0.0,
        align="center",
        case="upper",
        reveal="line",
        r=_arr(n, 1),
        g=_arr(n, 1),
        b=_arr(n, 1),
        opacity=_arr(n, 1),
        font="anton",
        outline=True,
        outline_width=0.15,
    )
    assert f.shape == (n, 128, 96, 4)
    a = f[0]
    white = (a[..., :3].min(-1) > 200) & (a[..., 3] > 200)  # opaque white fill
    black = (a[..., :3].max(-1) < 40) & (a[..., 3] > 200)  # opaque black outline
    assert int(white.sum()) > 0 and int(black.sum()) > 0


def _cover(size_min=0.0, size_max=1.0, text="AB"):
    """Lit-pixel count of a 1-frame render — a proxy for the fitted font size."""
    n = 1
    f = sources.lyrics(
        n,
        128,
        96,
        8,
        lines=[{"t0": 0, "t1": 2, "text": text}],
        seg_start=0.0,
        align="center",
        case="none",
        reveal="line",
        r=_arr(n, 1),
        g=_arr(n, 1),
        b=_arr(n, 1),
        opacity=_arr(n, 1),
        font="anton",
        outline=False,
        size_min=size_min,
        size_max=size_max,
    )
    return int((f[0, ..., 3] > 0).sum())


def test_lyrics_size_max_caps_the_auto_fit():
    # A short line normally grows to the box height; capped at 8% of the frame it
    # must come out much smaller — and the defaults reproduce the unclamped render.
    assert _cover(size_max=0.08) < _cover() * 0.6
    assert _cover() == _cover(size_min=0.0, size_max=1.0)


def test_lyrics_size_min_floors_the_auto_fit():
    # A long line normally shrinks far below the floor; with `px_min` the shrink
    # stops there even though the block then overflows the box (the card's explicit
    # choice: readable-but-clipped beats unreadable).
    from PIL import Image, ImageDraw

    draw = ImageDraw.Draw(Image.new("RGBA", (200, 200)))
    long = "a very long lyric line that has to shrink hard to fit the box"
    _, px_free, *_ = sources._fit(long, "anton", 100, 100, 40, draw, 0.0)
    _, px_floor, *_ = sources._fit(long, "anton", 100, 100, 40, draw, 0.0, px_min=60)
    assert px_free < 60
    assert px_floor == 60
    # A floor above the start size wins over it too (min beats max).
    _, px_hi, *_ = sources._fit("hi", "anton", 20, 1000, 1000, draw, 0.0, px_min=60)
    assert px_hi == 60
    # …and the same floor through the public surface: more lit pixels than the free fit.
    assert _cover(size_min=0.2, text=long) > _cover(text=long)


def test_lyrics_wraps_long_line_inside_the_box():
    long = " ".join(["mot"] * 24)
    f = sources.lyrics(
        1,
        200,
        120,
        8,
        lines=[{"t0": 0, "t1": 2, "text": long}],
        seg_start=0.0,
        align="center",
        case="none",
        reveal="line",
        r=_arr(1, 1),
        g=_arr(1, 1),
        b=_arr(1, 1),
        opacity=_arr(1, 1),
        font="inter",
        outline=False,
        box_x=0.1,
        box_y=0.1,
        box_w=0.8,
        box_h=0.8,
    )
    ys, xs = np.where(f[0, ..., 3] > 0)  # every drawn pixel stays within the box (± a few px)
    assert xs.min() >= int(0.1 * 120) - 6 and xs.max() <= int(0.9 * 120) + 6
    assert ys.min() >= int(0.1 * 200) - 6 and ys.max() <= int(0.9 * 200) + 6


def test_black_lyrics_outline_occludes_fluid_in_composite():
    bright = np.full((1, 6, 6, 3), 220, np.uint8)  # a bright fluid beneath
    ly = np.zeros((1, 6, 6, 4), np.uint8)  # opaque black RGBA on top
    ly[..., 3] = 255
    out = graph.composite([ly, bright], [1.0, 1.0])  # ly is the TOP layer
    assert out.shape == (1, 6, 6, 3) and int(out.max()) < 10  # fluid fully occluded


def test_rgba_lyrics_layer_flattens_to_rgb():
    ly = np.zeros((1, 4, 4, 4), np.uint8)  # opaque black RGBA
    ly[..., 3] = 255
    out = fluid.flatten(ly)
    assert out.shape == (1, 4, 4, 3) and int(out.max()) < 10  # opaque black -> black, 3-channel


def _color_node(nid, r, g, b):
    ports = {
        k: {"binding": {"kind": "const", "value": v}}
        for k, v in [
            ("r", r),
            ("g", g),
            ("b", b),
            ("intensity", 1.0),
            ("opacity", 1.0),
            ("position", 0.0),
        ]
    }
    return {"id": nid, "type": "color", "data": {"mode": "rgb", "stops": [], "ports": ports}}


def _ly_node():
    return {
        "id": "ly",
        "type": "lyrics",
        "data": {
            "font": "anton",
            "position": "center",
            "align": "center",
            "case": "upper",
            "reveal": "line",
            "outlineWidth": 0.16,
            "ports": {},
        },
    }


def _render_lyrics_layer(extra_nodes, extra_edges):
    seg = {
        "start": 0.0,
        "end": 1.0,
        "signals": [],
        "lyric_lines": [{"t0": 0, "t1": 1, "text": "AB"}],
    }
    nodes = [
        _ly_node(),
        {"id": "o", "type": "output", "x": 0, "y": 0, "data": {"title": "p"}},
    ] + extra_nodes
    edges = [
        {"id": "eo", "source": "ly", "sourcePort": "out", "target": "o", "targetPort": "video"}
    ] + extra_edges
    g = {"version": 11, "nodes": nodes, "edges": edges}
    graph.validate(g)
    dag = graph.Dag("job", seg, g, lambda j, s: None, {"fps": 6, "width": 160, "height": 120})
    return dag.video("ly")[3]  # the RGBA lyrics layer, mid-clip frame


def test_lyrics_defaults_to_white_fill_black_outline():
    a = _render_lyrics_layer([], [])
    op = a[..., 3] > 200
    assert int(((a[..., :3].min(-1) > 200) & op).sum()) > 0  # white fill
    assert int(((a[..., :3].max(-1) < 40) & op).sum()) > 0  # black outline


def test_lyrics_fill_color_input_drives_the_fill():
    a = _render_lyrics_layer(
        [_color_node("cf", 1, 0, 0)],
        [
            {
                "id": "ef",
                "source": "cf",
                "sourcePort": "out",
                "target": "ly",
                "targetPort": "fillColor",
            }
        ],
    )
    op = a[..., 3] > 200
    assert int(((a[..., 0] > 180) & (a[..., 1] < 80) & (a[..., 2] < 80) & op).sum()) > 0  # red fill
    assert int(((a[..., :3].min(-1) > 200) & op).sum()) == 0  # no white fill left


def test_lyrics_outline_color_input_stays_opaque_and_occludes():
    base = _render_lyrics_layer([], [])
    n_opaque = int((base[..., 3] > 200).sum())
    a = _render_lyrics_layer(
        [_color_node("co", 0, 0, 1)],
        [
            {
                "id": "eoc",
                "source": "co",
                "sourcePort": "out",
                "target": "ly",
                "targetPort": "outlineColor",
            }
        ],
    )
    op = a[..., 3] > 200
    assert int(((a[..., 2] > 180) & (a[..., 0] < 80) & op).sum()) > 0  # blue outline
    assert int(op.sum()) == n_opaque  # colour change doesn't change the (occluding) coverage


LINES = [
    {"t0": 0.0, "t1": 2.0, "text": "hello world this is kaika"},
    {"t0": 2.0, "t1": 4.0, "text": "second line here"},
]


def test_lyrics_word_reveal_changes_over_a_line():
    f = sources.lyrics(
        16,
        64,
        160,
        8,
        lines=LINES,
        seg_start=0.0,
        align="center",
        case="none",
        reveal="word",
        r=_arr(16, 1),
        g=_arr(16, 1),
        b=_arr(16, 1),
        opacity=_arr(16, 1),
    )
    early, late = f[1], f[14]  # ~0.12s (one word) vs ~1.75s (most of the line)
    assert int(early[..., 3].max()) > 0 and int(late[..., 3].max()) > 0  # both show text
    assert not np.array_equal(early, late)  # more words revealed -> the frame changed


def test_lyrics_empty_when_no_lines():
    f = sources.lyrics(
        4,
        32,
        64,
        8,
        lines=[],
        seg_start=0.0,
        align="center",
        case="none",
        reveal="line",
        r=_arr(4, 1),
        g=_arr(4, 1),
        b=_arr(4, 1),
        opacity=_arr(4, 1),
    )
    assert int(f.max()) == 0


def _lyrics_graph():
    return {
        "version": 6,
        "nodes": [
            {
                "id": "ly",
                "type": "lyrics",
                "x": 0,
                "y": 0,
                "data": {
                    "position": "bottom",
                    "align": "center",
                    "case": "none",
                    "reveal": "word",
                    "ports": {},
                },
            },
            {"id": "o1", "type": "output", "x": 0, "y": 0, "data": {"title": "p"}},
        ],
        "edges": [
            {"id": "e1", "source": "ly", "sourcePort": "out", "target": "o1", "targetPort": "video"}
        ],
    }


def test_lyrics_render_reads_segment_lines():
    seg = {"start": 0.0, "end": 4.0, "signals": [], "lyric_lines": LINES}
    g = _lyrics_graph()
    graph.validate(g)
    dag = graph.Dag("job", seg, g, lambda j, s: None, {"fps": 8, "width": 160, "height": 64})
    frames = dag.video("o1")
    assert frames.shape[0] == 32 and int(frames.max()) > 0


def test_lyrics_hash_busts_on_lyric_change():
    g = _lyrics_graph()
    seg = {"start": 0.0, "end": 4.0, "signals": [], "lyric_lines": LINES}
    other = {
        "start": 0.0,
        "end": 4.0,
        "signals": [],
        "lyric_lines": [{"t0": 0, "t1": 4, "text": "totally different"}],
    }
    h1 = graph.output_hash("job", seg, g, "o1", {"fps": 8})
    h2 = graph.output_hash("job", other, g, "o1", {"fps": 8})
    assert h1 != h2
