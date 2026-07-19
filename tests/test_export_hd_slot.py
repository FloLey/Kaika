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
from backend.routes import export as EX


@pytest.fixture
def free_slot():
    """A released slot before and after — the semaphore is module-global, so a test that
    leaves it held would 409 every later test."""
    _drain(EX)
    yield
    _drain(EX)


def _drain(mod):
    while True:
        try:
            mod._HD_SLOT.release()
        except ValueError:  # BoundedSemaphore: already fully released
            break
    mod._HD_RUNNING = None


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
    seg = {
        "id": "s1",
        "start": 0.0,
        "end": 1.0,
        "signals": [],
        "graph": graph,
        "finalOutputId": "o",
    }
    row = {"job_id": "abcd1234", "data": {"segments": [seg], "output": {}, "export": {}}}
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
    assert EX._HD_SLOT.acquire(blocking=False), "the failed export leaked the HD slot"
    EX._HD_SLOT.release()


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
            "graph": one_segment_project["data"]["segments"][0]["graph"],
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
    assert EX._HD_SLOT.acquire(blocking=False), "a rejected export consumed the HD slot"
    EX._HD_SLOT.release()


def test_export_song_404s_an_unknown_project(client, free_slot, monkeypatch):
    monkeypatch.setattr(db, "get_project", lambda jid: None)
    assert client.post("/export/stream", json={"job_id": "ghost"}).status_code == 404
    assert EX._HD_SLOT.acquire(blocking=False), "a 404 consumed the HD slot"
    EX._HD_SLOT.release()
