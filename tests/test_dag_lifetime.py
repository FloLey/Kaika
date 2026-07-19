"""Every render entry point releases what its DAG opened.

A `Dag` acquires three kinds of resource: per-combine thread pools, incremental
frame-cache writers, and persistent ffmpeg decoders (the slideshow / video / stylize
block handlers register `clip.close` on it). The drain used to live ONLY in
`stream_blocks`' finally, so `render()`, `song_render` and the two resolvers leaked.

Why the existing suite could not catch this: `test_card_impact`'s whole-vs-streamed
parity test — the one place both paths are exercised together — constructs a fresh `Dag`
and calls `.video()` / `.stream_blocks()` DIRECTLY. It never goes through `render()`, so
it stays green through the leak.

These tests matter most for cleanup step 07: converting slideshow / video / stylize to
`_whole_from_block` moves their `clip.close` registrations onto the synchronous path.
Today that path registers no closers, so a test that merely observed current behaviour
would pass for the wrong reason and keep passing after the conversion broke it. So the
CONTRACT is pinned instead: close() drains, and every entry point calls it.
"""

from __future__ import annotations

import numpy as np
import pytest

from backend import graph_render as GR
from backend import song_render as SR

SEG = {"id": "s1", "start": 0.0, "end": 0.5, "signals": [], "lyric_lines": []}
OUT = {"width": 64, "height": 64, "quality": "draft", "fps": 8}
NOAUDIO = lambda j, s: None  # noqa: E731


def _graph():
    """A backdrop straight into an output — no sim, so this renders fast."""
    return {
        "version": 26,
        "nodes": [
            {
                "id": "b",
                "type": "backdrop",
                "data": {
                    "color": "#204080",
                    "ports": {"opacity": {"binding": {"kind": "const", "value": 1}}},
                },
            },
            {"id": "o", "type": "output", "data": {}},
        ],
        "edges": [
            {"id": "e", "source": "b", "sourcePort": "out", "target": "o", "targetPort": "video"}
        ],
    }


def _dag():
    return GR.Dag("job", SEG, _graph(), NOAUDIO, OUT)


# ---- the drain itself --------------------------------------------------------


def test_close_drains_all_three_resource_lists():
    dag = _dag()
    closed, discarded = [], []
    dag._closers.append(lambda: closed.append(1))
    dag._cache_writers.append(lambda: discarded.append(1))

    dag.close()

    assert closed == [1], "a decoder was never closed"
    assert discarded == [1], "a partial frame cache was never discarded"
    assert dag._closers == [] and dag._cache_writers == [] and dag._executors == []


def test_close_is_idempotent():
    """It runs from `finally` blocks that can nest, so a second call must be a no-op
    rather than closing a decoder twice."""
    dag = _dag()
    calls = []
    dag._closers.append(lambda: calls.append(1))

    dag.close()
    dag.close()

    assert calls == [1]


def test_one_raising_closer_does_not_strand_the_others():
    """Cleanup runs while an exception may already be propagating. A decoder that throws
    on close must not prevent the rest from being reaped, and must not replace the
    original error."""
    dag = _dag()
    reaped = []

    def bad():
        raise RuntimeError("decoder already gone")

    dag._closers.extend([bad, lambda: reaped.append("after")])
    dag._cache_writers.append(bad)

    dag.close()  # must not raise

    assert reaped == ["after"], "a raising closer stranded the ones after it"


def test_the_context_manager_closes_on_exception_without_swallowing_it():
    dag = _dag()
    closed = []
    dag._closers.append(lambda: closed.append(1))

    with pytest.raises(ValueError, match="boom"):
        with dag:
            raise ValueError("boom")

    assert closed == [1], "__exit__ did not drain on the error path"


# ---- every entry point uses it ----------------------------------------------


def _counting_close(monkeypatch):
    """Count `Dag.close()` calls while keeping the real drain."""
    calls = []
    real = GR.Dag.close

    def spy(self):
        calls.append(1)
        return real(self)

    monkeypatch.setattr(GR.Dag, "close", spy)
    return calls


def test_render_closes_its_dag(monkeypatch, tmp_path):
    """The sync path. It had no try/finally at all, so it leaked one decoder per video
    card per call — and step 07 routes slideshow/video/stylize through here."""
    monkeypatch.setattr(GR.paths, "ANIM_DIR", tmp_path)
    calls = _counting_close(monkeypatch)

    GR.render("job", SEG, _graph(), NOAUDIO, OUT, "o")

    assert calls, "render() never closed its DAG"


def test_render_closes_its_dag_even_when_the_render_fails(monkeypatch, tmp_path):
    monkeypatch.setattr(GR.paths, "ANIM_DIR", tmp_path)
    calls = _counting_close(monkeypatch)
    monkeypatch.setattr(
        GR.fluid, "render_mp4", lambda *a, **k: (_ for _ in ()).throw(OSError("no"))
    )

    with pytest.raises(OSError):
        GR.render("job", SEG, _graph(), NOAUDIO, OUT, "o")

    assert calls, "a failed render() leaked its DAG"


def test_stream_blocks_still_closes_its_dag(monkeypatch):
    """The path that always did — guard against the refactor losing it."""
    calls = _counting_close(monkeypatch)
    list(_dag().stream_blocks("o", 2))
    assert calls, "stream_blocks() stopped closing its DAG"


def test_resolve_node_points_closes_its_dag(monkeypatch):
    calls = _counting_close(monkeypatch)
    g = {
        "version": 26,
        "nodes": [{"id": "p", "type": "points", "data": {"points": [[0.5, 0.5]]}}],
        "edges": [],
    }
    GR.resolve_node_points("job", SEG, g, "p", NOAUDIO)
    assert calls, "resolve_node_points() leaked its DAG"


def test_song_render_closes_every_planned_dag(monkeypatch, tmp_path):
    """`build_plan` opens one DAG per segment and they outlive it by design, so the drain
    is an outer finally in `render_song`. It must also cover the CACHE-HIT early return,
    which previously leaked a decoder per video card on every repeat export."""
    monkeypatch.setattr(SR.paths, "ANIM_DIR", tmp_path)
    seg = {**SEG, "graph": _graph(), "finalOutputId": "o"}
    export = {**SR.EXPORT_DEFAULTS, "width": 64, "height": 64, "fps": 8}

    ctx = SR.build_plan("job", [seg], [], export, NOAUDIO)
    closed = []
    for dag, *_ in ctx["plan"]:
        dag._closers.append(lambda: closed.append(1))

    SR.close_plan(ctx)
    assert closed, "close_plan did not drain the planned DAGs"

    # And the cache-hit path: pre-create the output so render_song returns early.
    calls = _counting_close(monkeypatch)
    out = tmp_path / f"song_{SR._export_hash('job', [seg], [], export)}.mp4"
    out.write_bytes(b"x")
    SR.render_song("job", [seg], [], export, NOAUDIO)
    assert calls, "the cache-hit early return leaked every planned DAG"


def test_a_rendered_clip_is_unchanged_by_the_drain(monkeypatch, tmp_path):
    """Sanity: draining must not truncate or alter the frames. A closer that fires too
    early (before the frames are read) is the one way this change could break rendering."""
    monkeypatch.setattr(GR.paths, "ANIM_DIR", tmp_path)
    with GR.Dag("job", SEG, _graph(), NOAUDIO, OUT) as dag:
        frames = np.array(dag.video("o"))
    assert frames.shape[0] == max(1, round(0.5 * 8))
    assert frames.max() > 0, "the clip came out black"
