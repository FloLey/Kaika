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
