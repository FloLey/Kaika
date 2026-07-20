"""Flask route smoke tests (Phase 4) — the first coverage of the HTTP layer.

Imports the full app (ML stack), so it skips where torch isn't installed (e.g. the
minimal CI image). Hits only routes that don't need a DB or audio on disk: presence
of routes, the json_body 400 guard, and the not-found paths.
"""

import pytest

pytest.importorskip("torch")

# `client` comes from conftest.py.


def test_index_ok(client):
    r = client.get("/")
    assert r.status_code == 200 and "service" in r.get_json()


def test_extract_rejects_non_object_body(client):
    assert client.post("/extract", json=[1, 2]).status_code == 400


def test_extract_unknown_job_is_404(client):
    r = client.post("/extract", json={"job_id": "nope", "stem": "drums", "start": 0, "end": 1})
    assert r.status_code == 404


def test_animate_stream_rejects_non_object_body(client):
    # `/animate` (the one-shot render) is gone; `/animate/stream` carries the same
    # validation and is the only one the frontend ever used.
    assert client.post("/animate/stream", json="nope").status_code == 400


def test_animate_stream_missing_fields_is_400(client):
    assert client.post("/animate/stream", json={"job_id": "x"}).status_code == 400


def test_fluid_rejects_non_object_body(client):
    assert client.post("/fluid", json=[1, 2]).status_code == 400


def test_resolve_honors_the_caller_fps(client):
    """/resolve samples on the caller's timeline: the montage card passes the project
    fps so its frame→seconds conversions match the render (a 30fps curve read as 24fps
    frames showed every window boundary 25% late). Junk fps falls back to 30."""
    g = {
        "nodes": [
            {"id": "l", "type": "lfo", "data": {"shape": "sine", "rateMode": "cycles", "rate": 2}}
        ],
        "edges": [],
    }
    body = {
        "job_id": "abcd1234",
        "segment": {"start": 0.0, "end": 2.0, "signals": []},
        "graph": g,
        "node_id": "l",
    }
    d30 = client.post("/resolve", json=body).get_json()
    assert d30["fps"] == 30 and len(d30["curve"]) == 60
    d24 = client.post("/resolve", json={**body, "fps": 24}).get_json()
    assert d24["fps"] == 24 and len(d24["curve"]) == 48
    assert client.post("/resolve", json={**body, "fps": "junk"}).get_json()["fps"] == 30


def test_jobs_unknown_is_404(client):
    assert client.get("/jobs/does-not-exist").status_code == 404


# --- one smoke per blueprint after the spec-03 split (no DB / no audio needed) ---


def test_upload_without_file_or_url_is_400(client):
    # uploads blueprint: the request-context validation runs before any work.
    assert client.post("/upload", data={}).status_code == 400


def test_segment_missing_job_id_is_400(client):
    # uploads blueprint: missing job_id is rejected before touching disk.
    assert client.post("/segment", json={}).status_code == 400


def test_segment_rejects_non_object_body(client):
    # @json_body now guards /segment like the other POST routes.
    assert client.post("/segment", json=[1, 2]).status_code == 400


def test_segment_malformed_job_id_is_400(client):
    # validate_job_id fails fast on a non 8-hex id (uniform {"error": ...} shape).
    r = client.post("/segment", json={"job_id": "NOTHEX!!"})
    assert r.status_code == 400 and r.get_json()["error"] == "invalid job_id"


def test_logs_feed_is_json(client):
    # uploads blueprint: the log feed never needs a DB.
    r = client.get("/logs?since=0")
    assert r.status_code == 200 and "entries" in r.get_json()


def test_fluid_file_non_mp4_is_404(client):
    # media blueprint: only .mp4 names are served.
    assert client.get("/fluid/not-a-video").status_code == 404


def test_spectrogram_unknown_stem_is_404(client):
    # media blueprint: a stem outside STEMS is rejected before any file read.
    assert client.get("/spectrogram/whatever/not-a-stem").status_code == 404


def test_audio_unknown_job_is_404(client):
    # media blueprint: no audio on disk -> 404.
    assert client.get("/audio/nope/drums").status_code == 404


def test_projects_list_shape(client):
    # projects blueprint: returns a list when a DB is up; skip otherwise.
    r = client.get("/projects")
    if r.status_code != 200:
        pytest.skip("no database available")
    assert isinstance(r.get_json(), list)
