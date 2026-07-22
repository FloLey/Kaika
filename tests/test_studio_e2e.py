"""The seam nothing covered: a real project, through the real HTTP routes, rendered.

Every other route test either checks an error shape (`test_app_routes`) or monkeypatches
the storage away (`test_assets`), and every render test calls the executor directly. Both
bugs that shipped this week — a segment of frozen frames, and previews that fetched
gigabytes — lived exactly here, between the routes and the render engine.

Uses the Playground project because it is deterministic, seeded by the app itself, and
committed as a fixture. Needs Postgres + ffmpeg like the other integration tests.
"""

from __future__ import annotations

import shutil

import numpy as np
import pytest

pytest.importorskip("torch")  # importing the app pulls the ML stack

from backend import graph, paths  # noqa: E402

from helpers import assert_moves, assert_not_black  # noqa: E402

_needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")

OUT = {"width": 96, "height": 128, "quality": "draft", "fps": 8}


@pytest.fixture
def playground(client, live_db):  # noqa: ARG001 — live_db gates on a reachable DB
    """The seeded Playground project, through the route the UI actually calls."""
    r = client.post("/playground")
    assert r.status_code == 200, r.get_data(as_text=True)
    project = client.get(f"/projects/{r.get_json()['job_id']}")
    assert project.status_code == 200
    return project.get_json()


def _root_graph(playground, seg):
    """A segment's graph through the composition pool — the shape the Studio reads."""
    pool = playground.get("compositions") or {}
    return (pool.get(seg.get("rootCompositionId") or "") or {}).get("graph") or {}


def test_playground_loads_through_the_real_routes(playground):
    """A project comes back with segments and a composition pool the segments
    reference — the shape the Studio needs."""
    segments = playground.get("segments") or []
    assert segments, "the Playground project has no segments"
    assert all(
        _root_graph(playground, s).get("nodes") for s in segments
    ), "a segment has no composition graph"


@_needs_ffmpeg
def test_a_segment_renders_a_real_moving_clip(playground, client):
    """Render one segment and check the FRAMES, not just that a file appeared: a render
    can happily produce 80 copies of one frozen image.

    Drives `graph.render` directly rather than the deleted `/animate` route. That route
    ran a one-shot multi-minute render inside the Flask request thread with no
    cancellation, and the frontend never called it (only `/animate/stream`). What this
    test is for -- a real segment produces a real moving clip, and `/fluid/<name>`
    serves it -- is unchanged, because `graph.render` is the code the route called."""
    seg = next(
        (
            s
            for s in playground["segments"]
            if any(n["type"] == "fluid" for n in _root_graph(playground, s)["nodes"])
        ),
        playground["segments"][0],
    )
    g = _root_graph(playground, seg)
    out_id = next(n["id"] for n in g["nodes"] if n["type"] == "output")
    body = {
        "job_id": playground["job_id"],
        "graph": g,
        "segment": {"start": seg["start"], "end": seg["end"], "signals": seg.get("signals", [])},
        "output": OUT,
        "output_id": out_id,
    }
    url = graph.render(body["job_id"], body["segment"], g, _stem_path, OUT, out_id)

    # /fluid/<name> serves it, and the served bytes are a real playable clip.
    served = client.get(url)
    assert served.status_code in (200, 206)
    assert len(served.get_data()) > 1000, "the served clip is suspiciously small"

    # …and the frames move. This is the assertion the whole file exists for.
    frames = graph.Dag(playground["job_id"], body["segment"], g, _stem_path, OUT).video(out_id)
    assert_not_black(frames, "rendered segment")
    assert_moves(frames, "rendered segment")


@_needs_ffmpeg
def test_rendering_twice_reuses_the_cached_clip(playground, client):
    """The second render must return the same URL — the render cache keyed on the graph.
    A hash that stopped being stable would silently re-render everything, forever."""
    seg = playground["segments"][0]
    g = _root_graph(playground, seg)
    out_id = next(n["id"] for n in g["nodes"] if n["type"] == "output")
    body = {
        "job_id": playground["job_id"],
        "graph": g,
        "segment": {"start": seg["start"], "end": seg["end"], "signals": seg.get("signals", [])},
        "output": OUT,
        "output_id": out_id,
    }
    first = graph.render(body["job_id"], body["segment"], g, _stem_path, OUT, out_id)
    second = graph.render(body["job_id"], body["segment"], g, _stem_path, OUT, out_id)
    assert first == second


def _stem_path(job_id, stem):
    from backend.media import stem_audio_path

    return stem_audio_path(job_id, stem)


def test_frozen_render_would_be_caught():
    """A guard on the guard: assert_moves must reject a stack of identical frames.

    Without this, a future refactor of the helper could silently defang every motion
    check in the suite — which is precisely the failure mode this cleanup exists to fix.
    """
    frozen = np.tile(np.full((1, 8, 8, 3), 200, np.uint8), (40, 1, 1, 1))
    with pytest.raises(AssertionError, match="static"):
        assert_moves(frozen, "deliberately frozen")
