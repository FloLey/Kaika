"""Flask route smoke tests (Phase 4) — the first coverage of the HTTP layer.

Imports the full app (ML stack), so it skips where torch isn't installed (e.g. the
minimal CI image). Hits only routes that don't need a DB or audio on disk: presence
of routes, the json_body 400 guard, and the not-found paths.
"""

import pytest

pytest.importorskip("torch")

from backend.app import app  # noqa: E402


@pytest.fixture
def client():
    app.config["TESTING"] = True
    return app.test_client()


def test_index_ok(client):
    r = client.get("/")
    assert r.status_code == 200 and "service" in r.get_json()


def test_extract_rejects_non_object_body(client):
    assert client.post("/extract", json=[1, 2]).status_code == 400


def test_extract_unknown_job_is_404(client):
    r = client.post("/extract", json={"job_id": "nope", "stem": "drums", "start": 0, "end": 1})
    assert r.status_code == 404


def test_animate_rejects_non_object_body(client):
    assert client.post("/animate", json="nope").status_code == 400


def test_animate_missing_fields_is_400(client):
    assert client.post("/animate", json={"job_id": "x"}).status_code == 400


def test_fluid_rejects_non_object_body(client):
    assert client.post("/fluid", json=[1, 2]).status_code == 400


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
