"""Phase S3: project (segment editor) API + staged jobs."""
from __future__ import annotations

import pytest

from conftest import SMALL_RECIPE as SMALL, upload_audio as _upload, wait_for_job as _wait


@pytest.fixture
def client(api_client):
    return api_client


def test_create_project_returns_segments_and_analysis(client, tmp_path):
    aid = _upload(client, tmp_path)
    r = client.post("/api/projects", json={"audio_id": aid, "recipe": SMALL, "seconds": 0.4})
    assert r.status_code == 200
    data = r.json()
    assert data["run_id"]
    assert len(data["project"]["segments"]) >= 1
    assert "waveform" in data["analysis"] and len(data["analysis"]["waveform"]) > 0
    # each segment carries an editable prompt
    assert "prompt" in data["project"]["segments"][0]


def test_edit_segment_prompt_persists(client, tmp_path):
    aid = _upload(client, tmp_path)
    data = client.post("/api/projects", json={"audio_id": aid, "recipe": SMALL,
                                              "seconds": 0.4}).json()
    run_id = data["run_id"]
    segs = data["project"]["segments"]
    segs[0]["prompt"] = "EDITED PROMPT"
    segs[0]["fluid"] = {"vorticity": {"min": 5, "max": 70}}
    r = client.put(f"/api/projects/{run_id}", json={"segments": segs})
    assert r.status_code == 200
    again = client.get(f"/api/projects/{run_id}").json()
    assert again["project"]["segments"][0]["prompt"] == "EDITED PROMPT"
    assert again["project"]["segments"][0]["fluid"]["vorticity"]["max"] == 70


def test_preview_then_generate_flow(client, tmp_path):
    aid = _upload(client, tmp_path)
    run_id = client.post("/api/projects", json={"audio_id": aid, "recipe": SMALL,
                                                "seconds": 0.4}).json()["run_id"]

    # fluid preview (no diffusion)
    job = client.post(f"/api/projects/{run_id}/preview").json()["job_id"]
    assert _wait(client, job)["status"] == "done"
    assert client.get(f"/api/runs/{run_id}/files/fluid_preview.mp4").status_code == 200
    assert client.get(f"/api/runs/{run_id}").json()["stage"] == "fluid"
    assert not (tmp_path / "runs" / run_id / "styled").exists()

    # generate (diffuse) resumes the same run
    job2 = client.post(f"/api/projects/{run_id}/generate").json()["job_id"]
    assert _wait(client, job2)["status"] == "done"
    assert client.get(f"/api/runs/{run_id}/final").status_code == 200
    m = client.get(f"/api/runs/{run_id}").json()
    assert m["stage"] == "done"


def test_generate_without_preview_builds_fluid(client, tmp_path):
    """Generate is self-sufficient: it builds the missing full fluid first."""
    aid = _upload(client, tmp_path)
    run_id = client.post("/api/projects", json={"audio_id": aid, "recipe": SMALL,
                                                "seconds": 0.4}).json()["run_id"]
    job = client.post(f"/api/projects/{run_id}/generate").json()["job_id"]
    assert _wait(client, job)["status"] == "done"
    assert client.get(f"/api/runs/{run_id}/final").status_code == 200


# ---- creative suggestions ----------------------------------------------------

def _project(client, tmp_path):
    aid = _upload(client, tmp_path)
    return client.post("/api/projects",
                       json={"audio_id": aid, "recipe": SMALL,
                             "seconds": 0.6}).json()


def test_preview_proposal_does_not_persist(client, tmp_path):
    data = _project(client, tmp_path)
    rid = data["run_id"]
    before = client.get(f"/api/projects/{rid}").json()["project"]
    prop = {"segment_index": 0, "fluid": {"field": {"vorticity": 19}}}
    r = client.post(f"/api/projects/{rid}/preview_proposal",
                    json={"proposal": prop})
    assert r.status_code == 200
    _wait(client, r.json()["job_id"])
    after = client.get(f"/api/projects/{rid}").json()["project"]
    assert after["segments"] == before["segments"]      # nothing written


def test_apply_suggestion_mutates_and_is_undoable(client, tmp_path):
    data = _project(client, tmp_path)
    rid = data["run_id"]
    prop = {"segment_index": 0, "prompt": "NEW LOOK",
            "fluid": {"render": {"exposure": 2.3}}}
    r = client.post(f"/api/projects/{rid}/apply_suggestion",
                    json={"proposal": prop})
    assert r.status_code == 200
    seg = r.json()["project"]["segments"][0]
    assert seg["prompt"] == "NEW LOOK" and seg["fluid"]["render"]["exposure"] == 2.3
    revs = client.get(f"/api/projects/{rid}/revisions").json()
    assert any(rv["note"] == "suggestion" for rv in revs)
    # bad proposal -> 400, project unchanged
    bad = {"segment_index": 0, "timeline": [{"action": "text", "at": 1,
                                             "text": ""}]}
    assert client.post(f"/api/projects/{rid}/apply_suggestion",
                       json={"proposal": bad}).status_code == 400


def test_suggest_endpoint_with_stub(client, tmp_path, monkeypatch):
    from kaika.core import suggest as SG
    plan = {"global": {"title": "X", "recipe_values": {"render.exposure": 2.0}},
            "segments": [{"segment_index": 0, "label": "intro",
                          "fluid": {"field": {"vorticity": 11}}}]}
    monkeypatch.setattr(SG, "generate_plan", lambda *a, **k: dict(plan))
    data = _project(client, tmp_path)
    rid = data["run_id"]
    # provider must be set so get_backend doesn't raise
    client.put("/api/settings", json={"llm_provider": "fake"})
    r = client.post(f"/api/projects/{rid}/suggest", json={"extra": "darker"})
    assert r.status_code == 200
    out = r.json()
    assert out["global"]["title"] == "X"
    assert out["segments"][0]["segment_index"] == 0
