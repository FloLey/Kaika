"""Unit tests for the lyrics source card.

Exercise the rasterizer (per-word reveal, timing), the render-path integration
(lyric lines ride in the segment payload), and that the render cache busts when the
lyrics change. Run with ``.venv/bin/python -m pytest``.
"""

import numpy as np

from backend import graph, sources


def _arr(t, v):
    return np.full(t, float(v), np.float32)


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
