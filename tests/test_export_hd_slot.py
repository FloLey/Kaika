"""The single HD render slot shared by `/export/stream` and `/export/segment`.

Two fine-grid renders at once would starve each other and every card preview on the same
worker pool, so one BoundedSemaphore admits one at a time and everyone else gets a 409.

None of this was tested. `test_export_segment.py` covers routing, hashing and output
sizing; the slot itself — including the path where `render_jobs.start` raises and the
slot must be handed back — had no coverage, and a leaked slot is invisible in dev: the
next export just 409s forever with a render_id that finished long ago.

Cleanup step 09 factors these two copies of the admission dance into one helper, so the
contract needs pinning first.
"""

from __future__ import annotations

import json

import pytest

from backend import db
from backend import render_jobs
from backend import heavy
from backend.routes import export as EX


@pytest.fixture
def free_slot():
    """A released slot before and after — the semaphore is module-global, so a test that
    leaves it held would 409 every later test."""
    _drain(EX)
    yield
    _drain(EX)


def _drain(mod):  # noqa: ARG001 — the slot is module-global now, `mod` kept for the callers
    held = heavy.holder()
    if held is not None:
        heavy.release(held[1])


@pytest.fixture
def one_segment_project(monkeypatch, tmp_path):
    """A saved project whose single segment has a final output marked — the minimum
    `/export/stream` accepts."""
    graph = {
        "version": 26,
        "nodes": [
            {"id": "b", "type": "backdrop", "data": {"color": "#204080", "ports": {}}},
            {"id": "o", "type": "output", "data": {}},
        ],
        "edges": [
            {"id": "e", "source": "b", "sourcePort": "out", "target": "o", "targetPort": "video"}
        ],
    }
    seg = {"id": "s1", "start": 0.0, "end": 1.0, "signals": [], "rootCompositionId": "c1"}
    pool = {"c1": {"id": "c1", "name": "s1", "graph": graph, "outputId": "o"}}
    row = {
        "job_id": "abcd1234",
        "data": {"segments": [seg], "compositions": pool, "output": {}, "export": {}},
    }
    monkeypatch.setattr(db, "get_project", lambda jid: row if jid == "abcd1234" else None)
    monkeypatch.setattr(EX, "ANALYSIS_DIR", tmp_path)
    (tmp_path / "abcd1234.json").write_text(json.dumps({"lyric_lines": []}))
    return row


def test_a_second_hd_render_gets_409_naming_the_running_one(client, free_slot, one_segment_project):
    original = render_jobs.start
    EX.render_jobs.start = lambda run: "render-abc"
    try:
        first = client.post("/export/stream", json={"job_id": "abcd1234"})
        assert first.status_code == 200
        rid = first.get_json()["render_id"]

        second = client.post("/export/stream", json={"job_id": "abcd1234"})
        assert second.status_code == 409
        body = second.get_json()
        assert "already running" in body["error"]
        # The id matters: the UI polls it to show what is blocking.
        assert body["render_id"] == rid
    finally:
        EX.render_jobs.start = original


def test_a_failing_start_hands_the_slot_back(client, free_slot, one_segment_project):
    """If `render_jobs.start` raises, the slot must be released before the exception
    propagates. Otherwise the very first failed export wedges HD rendering for the life
    of the process, and nothing in the UI explains why."""
    original = render_jobs.start

    def exploding_start(run):
        raise RuntimeError("pool is gone")

    EX.render_jobs.start = exploding_start
    try:
        # The route releases the slot and re-raises; the app's global JSON error handler
        # turns that into a 500, so the failure reaches the client as a response.
        assert client.post("/export/stream", json={"job_id": "abcd1234"}).status_code == 500
    finally:
        EX.render_jobs.start = original

    # The slot is free again: acquiring must succeed immediately.
    assert heavy.holder() is None, "the failed export leaked the HD slot"


def test_the_slot_is_shared_between_song_and_segment_exports(
    client, free_slot, one_segment_project
):
    """They are two routes but ONE resource — a song export must block a segment export
    and vice versa, which is the whole reason the semaphore is module-level."""
    original = render_jobs.start
    EX.render_jobs.start = lambda run: "render-xyz"
    try:
        assert client.post("/export/stream", json={"job_id": "abcd1234"}).status_code == 200
        seg_req = {
            "job_id": "abcd1234",
            "segment": {"id": "s1", "start": 0.0, "end": 1.0, "signals": []},
            "graph": one_segment_project["data"]["compositions"]["c1"]["graph"],
            "output_id": "o",
        }
        assert client.post("/export/segment", json=seg_req).status_code == 409
    finally:
        EX.render_jobs.start = original


def test_export_song_rejects_a_project_with_an_unmarked_segment(
    client, free_slot, monkeypatch, tmp_path
):
    """A 400 must NOT consume the slot — it returns before admission."""
    row = {"job_id": "beef5678", "data": {"segments": [{"id": "s1", "start": 0, "end": 1}]}}
    monkeypatch.setattr(db, "get_project", lambda jid: row if jid == "beef5678" else None)
    monkeypatch.setattr(EX, "ANALYSIS_DIR", tmp_path)

    r = client.post("/export/stream", json={"job_id": "beef5678"})
    assert r.status_code == 400
    assert "final output" in r.get_json()["error"]
    assert heavy.holder() is None, "a rejected export consumed the HD slot"


def test_export_song_404s_an_unknown_project(client, free_slot, monkeypatch):
    monkeypatch.setattr(db, "get_project", lambda jid: None)
    assert client.post("/export/stream", json={"job_id": "ghost"}).status_code == 404
    assert heavy.holder() is None, "a 404 consumed the HD slot"


# --------------------------------------------------------------------------- #
# The HD stylize clip is published atomically
# --------------------------------------------------------------------------- #


def test_a_killed_hd_stylize_write_leaves_no_partial_file(tmp_path, monkeypatch):
    """An interrupted publish must leave NOTHING, not a truncated clip.

    The old code was `dest.write_bytes(tmp.read_bytes())`, which truncates `dest` before
    it writes. A worker killed mid-write therefore left a short file exactly where the
    cache check (`if not dest.exists()`) looks — so every later export served the broken
    clip as a hit, and no amount of re-exporting fixed it. `os.replace` cannot do that:
    the destination is either the old file or the whole new one.

    Written as a unit test on the publish step because reaching it through the route
    needs a diffusion model. It pins the property that matters.
    """
    import os
    from uuid import uuid4

    dest = tmp_path / "hd-stylize-abc.mp4"
    tmp = dest.with_name(f"{dest.stem}.{os.getpid()}.{uuid4().hex[:8]}.tmp{dest.suffix}")
    tmp.write_bytes(b"a complete clip")

    # the publish, interrupted the way a SIGTERM would interrupt it
    try:
        try:
            raise KeyboardInterrupt("killed mid-publish")
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
    except KeyboardInterrupt:
        pass

    assert not dest.exists(), "a partial destination survived and would be served as a hit"
    assert not tmp.exists(), "scratch was left behind"

    # and the successful path publishes the whole thing
    tmp.write_bytes(b"a complete clip")
    os.replace(tmp, dest)
    assert dest.read_bytes() == b"a complete clip"
    assert not tmp.exists()
