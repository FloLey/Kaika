"""Streaming block renders (progressive preview).

The core guarantee is that streaming changes *when* you see frames, never *which*
frames: block-by-block production must be byte-identical to the monolithic path at
the raw-frame level. We assert that for the resumable sim (`FluidClip`), for the
whole DAG (`_Dag.stream_blocks` vs `video`), and then exercise the terminal
`render_stream` (progress + cancellation) where ffmpeg is available.
"""

from __future__ import annotations

import shutil
import subprocess

import numpy as np
import pytest

from backend import fluid
from backend import graph as G

_needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")

OUT = {"width": 96, "height": 128, "quality": "draft", "fps": 24, "background": "#101418"}
SEG = {
    "start": 0.0,
    "end": 2.3,
    "signals": [],
    "lyric_lines": [{"t0": 0.2, "t1": 1.6, "text": "les avions dessinent dans le ciel"}],
}
NOAUDIO = lambda j, s: None  # noqa: E731


def _fl(nid, color, pos, angle):
    ports = {
        k: {"binding": {"kind": "const", "value": v}}
        for k, v in [
            ("r", color[0]),
            ("g", color[1]),
            ("b", color[2]),
            ("angle", angle),
            ("force", 42),
            ("emit", 0.45),
            ("radius", 0.07),
        ]
    }
    static = {"enabled": True, "wrap": True, "points": [pos], "path_speed": 1, "color": list(color)}
    return {"id": nid, "type": "fluid", "data": {"static": static, "ports": ports}}


def _edge(s, t, tp):
    return {"id": s + t + tp, "source": s, "sourcePort": "out", "target": t, "targetPort": tp}


def _mod_graph():
    # a fluid whose `force` port is driven by an LFO -> output. Exercises value
    # resolution into a fluid port plus the fluid sim, with no video-FX cards.
    fl = _fl("f1", (0.3, 0.7, 1.0), [0.3, 0.4], 0)
    fl["data"]["ports"]["force"] = {"binding": {"kind": "node", "nodeId": "lfo", "lo": 0, "hi": 60}}
    return {
        "version": 5,
        "nodes": [
            fl,
            {"id": "lfo", "type": "lfo", "data": {"rateMode": "cycles", "rate": 2}},
            {"id": "o1", "type": "output", "data": {}},
        ],
        "edges": [
            _edge("lfo", "f1", "force"),
            _edge("f1", "o1", "video"),
        ],
    }


def _stack_lyrics_graph():
    return {
        "version": 1,
        "nodes": [
            _fl("fA", (1.0, 0.2, 0.45), [0.5, 0.5], 0),
            {
                "id": "ly",
                "type": "lyrics",
                "data": {
                    "position": "bottom",
                    "align": "center",
                    "case": "upper",
                    "reveal": "word",
                    "ports": {},
                },
            },
            {
                "id": "cb",
                "type": "combine",
                "data": {
                    "mode": "stack",
                    "inputs": [{"id": "s0", "opacity": 1.0}, {"id": "s1", "opacity": 0.8}],
                    "medium": {},
                },
            },
            {"id": "out1", "type": "output", "data": {}},
        ],
        "edges": [_edge("ly", "cb", "s0"), _edge("fA", "cb", "s1"), _edge("cb", "out1", "video")],
    }


def test_fluidclip_blocks_equal_simulate():
    params = {
        "output": {"width": 1080, "height": 1920, "quality": "draft", "fps": 24},
        "duration": 3.0,
        "source": {
            "emit": 0.4,
            "radius": 0.1,
            "force": 25.0,
            "points": [[0.3, 0.3], [0.7, 0.7]],
            "path_speed": 1.5,
        },
        "fluid": {"vorticity": 6.0},
    }
    full, _, _ = fluid.simulate(params)
    clip = fluid.FluidClip(params)
    blocks = [clip.advance(a, min(a + 17, clip.nframes)) for a in range(0, clip.nframes, 17)]
    assert np.array_equal(full, np.concatenate(blocks))


def test_fluidclip_advance_must_be_contiguous():
    clip = fluid.FluidClip({"grid": 24, "duration": 1, "source": {}, "fluid": {}})
    clip.advance(0, 5)
    with pytest.raises(ValueError):
        clip.advance(10, 15)  # skipped [5,10): the sim can't jump ahead


# `out_id` is an OUTPUT (stream its input) OR a producer node streamed DIRECTLY
# (`f1`, the fluid) — the per-node card-preview path. Both must equal `.video(id)`.
@pytest.mark.parametrize(
    "build,out_id", [(_mod_graph, "o1"), (_mod_graph, "f1"), (_stack_lyrics_graph, "out1")]
)
def test_stream_blocks_equal_video(build, out_id):
    g = build()
    G.validate(g)
    whole = G._Dag("job", SEG, g, NOAUDIO, OUT).video(out_id)
    dag = G._Dag("job", SEG, g, NOAUDIO, OUT)
    streamed = np.concatenate([f for _, _, _, f in dag.stream_blocks(out_id, 11)])
    assert np.array_equal(whole, streamed)


@_needs_ffmpeg
def test_render_stream_progress_and_finalize(tmp_path, monkeypatch):
    g = _mod_graph()
    oh = G.output_hash("job", SEG, g, "o1", OUT)
    (G.ANIM_DIR / f"{oh}.mp4").unlink(missing_ok=True)
    events = []
    url = G.render_stream(
        "job",
        SEG,
        g,
        NOAUDIO,
        OUT,
        "o1",
        block_seconds=1.0,
        on_progress=lambda d, t, u: events.append((d, t, u)),
    )
    total = events[-1][1]
    assert url == f"/fluid/{oh}.mp4"
    assert (G.ANIM_DIR / f"{oh}.mp4").exists()
    # the fragmented final decodes to exactly `total` frames (streaming changed WHEN
    # frames appear, not how many)
    probe = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-count_frames",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=nb_read_frames",
            "-of",
            "default=nk=1:nw=1",
            str(G.ANIM_DIR / f"{oh}.mp4"),
        ],
        capture_output=True,
        text=True,
    )
    assert int(probe.stdout.strip()) == total
    # frames_done climbs to total across >1 block, then a final event carries the url
    assert [e[0] for e in events] == sorted(e[0] for e in events)
    assert events[-1][2] == url and events[-1][0] == total
    # growing previews: one stable file, cache-busting `?n=` so the client reloads it
    assert all("/stream/" in e[2] and "?n=" in e[2] for e in events[:-1])
    assert not list(G.STREAM_DIR.glob(f"{oh}*"))  # per-render scratch cleaned up


@_needs_ffmpeg
def test_render_stream_cancel_stops_early():
    g = _mod_graph()
    oh = G.output_hash("job", SEG, g, "o1", OUT)
    (G.ANIM_DIR / f"{oh}.mp4").unlink(missing_ok=True)
    calls = {"n": 0}

    def cancel():
        calls["n"] += 1
        return calls["n"] >= 2  # cancel after the first block

    out = G.render_stream(
        "job", SEG, g, NOAUDIO, OUT, "o1", block_seconds=1.0, should_cancel=cancel
    )
    assert out is None
    assert not (G.ANIM_DIR / f"{oh}.mp4").exists()  # no partial promoted to the cache
    assert not list(G.STREAM_DIR.glob(f"{oh}*"))  # per-render scratch cleaned up


def test_render_stream_cache_hit_needs_no_dag(monkeypatch):
    """A clip already on disk short-circuits BEFORE any graph resolution: there is
    nothing to stream, and the frame total the progress callback reports is just
    duration x fps (`_clip_dims`, the one place the 0.5s floor lives)."""
    g = _mod_graph()
    oh = G.output_hash("job", SEG, g, "o1", OUT)
    cached = G.ANIM_DIR / f"{oh}.mp4"
    cached.parent.mkdir(parents=True, exist_ok=True)
    cached.write_bytes(b"cached clip")
    monkeypatch.setattr(G, "_Dag", lambda *a, **k: pytest.fail("a cache hit must not build a Dag"))
    seen = []
    url = G.render_stream("job", SEG, g, NOAUDIO, OUT, "o1", on_progress=lambda *a: seen.append(a))
    assert url == f"/fluid/{oh}.mp4"
    expected = max(1, round(max(0.5, SEG["end"] - SEG["start"]) * OUT["fps"]))
    assert seen == [(expected, expected, url)]
    cached.unlink()
