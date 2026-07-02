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
        n, 128, 96, 8, lines=[{"t0": 0, "t1": 2, "text": "AB"}], seg_start=0.0,
        position="center", align="center", case="upper", reveal="line",
        size=_arr(n, 0.3), r=_arr(n, 1), g=_arr(n, 1), b=_arr(n, 1), opacity=_arr(n, 1),
        font="anton", outline=True, outline_width=0.15,
    )
    assert f.shape == (n, 128, 96, 4)
    a = f[0]
    white = (a[..., :3].min(-1) > 200) & (a[..., 3] > 200)  # opaque white fill
    black = (a[..., :3].max(-1) < 40) & (a[..., 3] > 200)   # opaque black outline
    assert int(white.sum()) > 0 and int(black.sum()) > 0


def test_lyrics_wraps_long_line_inside_the_box():
    long = " ".join(["mot"] * 24)
    f = sources.lyrics(
        1, 200, 120, 8, lines=[{"t0": 0, "t1": 2, "text": long}], seg_start=0.0,
        position="center", align="center", case="none", reveal="line",
        size=_arr(1, 0.12), r=_arr(1, 1), g=_arr(1, 1), b=_arr(1, 1), opacity=_arr(1, 1),
        font="inter", outline=False, box_x=0.1, box_y=0.1, box_w=0.8, box_h=0.8,
    )
    ys, xs = np.where(f[0, ..., 3] > 0)  # every drawn pixel stays within the box (± a few px)
    assert xs.min() >= int(0.1 * 120) - 6 and xs.max() <= int(0.9 * 120) + 6
    assert ys.min() >= int(0.1 * 200) - 6 and ys.max() <= int(0.9 * 200) + 6


def test_black_lyrics_outline_occludes_fluid_in_composite():
    bright = np.full((1, 6, 6, 3), 220, np.uint8)             # a bright fluid beneath
    ly = np.zeros((1, 6, 6, 4), np.uint8)                     # opaque black RGBA on top
    ly[..., 3] = 255
    out = graph.composite([ly, bright], [1.0, 1.0])          # ly is the TOP layer
    assert out.shape == (1, 6, 6, 3) and int(out.max()) < 10  # fluid fully occluded


def test_apply_background_flattens_rgba_over_bg():
    ly = np.zeros((1, 4, 4, 4), np.uint8)                    # opaque black RGBA
    ly[..., 3] = 255
    out = fluid.apply_background(ly, "#ff0000")
    assert out.shape == (1, 4, 4, 3) and int(out.max()) < 10  # black stays black, not red


LINES = [
    {"t0": 0.0, "t1": 2.0, "text": "hello world this is kaika"},
    {"t0": 2.0, "t1": 4.0, "text": "second line here"},
]


def test_lyrics_word_reveal_grows_over_a_line():
    f = sources.lyrics(
        16, 64, 160, 8, lines=LINES, seg_start=0.0, position="bottom", align="center",
        case="none", reveal="word", size=_arr(16, 0.1), r=_arr(16, 1), g=_arr(16, 1), b=_arr(16, 1),
        opacity=_arr(16, 1),
    )
    early = int((f[1].max(-1) > 10).sum())  # ~0.12s in, one word
    late = int((f[14].max(-1) > 10).sum())  # ~1.75s in, most of the line
    assert 0 < early < late


def test_lyrics_empty_when_no_lines():
    f = sources.lyrics(
        4, 32, 64, 8, lines=[], seg_start=0.0, position="bottom", align="center", case="none",
        reveal="line", size=_arr(4, 0.1), r=_arr(4, 1), g=_arr(4, 1), b=_arr(4, 1), opacity=_arr(4, 1),
    )
    assert int(f.max()) == 0


def _lyrics_graph():
    return {
        "version": 6,
        "nodes": [
            {"id": "ly", "type": "lyrics", "x": 0, "y": 0,
             "data": {"position": "bottom", "align": "center", "case": "none", "reveal": "word", "ports": {}}},
            {"id": "o1", "type": "output", "x": 0, "y": 0, "data": {"title": "p"}},
        ],
        "edges": [{"id": "e1", "source": "ly", "sourcePort": "out", "target": "o1", "targetPort": "video"}],
    }


def test_lyrics_render_reads_segment_lines():
    seg = {"start": 0.0, "end": 4.0, "signals": [], "lyric_lines": LINES}
    g = _lyrics_graph()
    graph.validate(g)
    dag = graph._Dag("job", seg, g, lambda j, s: None, {"fps": 8, "width": 160, "height": 64})
    frames = dag.video("o1")
    assert frames.shape[0] == 32 and int(frames.max()) > 0


def test_lyrics_hash_busts_on_lyric_change():
    g = _lyrics_graph()
    seg = {"start": 0.0, "end": 4.0, "signals": [], "lyric_lines": LINES}
    other = {"start": 0.0, "end": 4.0, "signals": [], "lyric_lines": [{"t0": 0, "t1": 4, "text": "totally different"}]}
    h1 = graph.output_hash("job", seg, g, "o1", {"fps": 8})
    h2 = graph.output_hash("job", other, g, "o1", {"fps": 8})
    assert h1 != h2
