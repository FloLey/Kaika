"""V2 API surface: schema, signals, recipe patch, timeline, revisions,
settings, chat (fake provider), window preview cancellation."""
from __future__ import annotations

import json

import pytest

from conftest import SMALL_RECIPE as SMALL, upload_audio as _upload, wait_for_job as _wait


@pytest.fixture
def client(api_client):
    return api_client


def _make_project(client, tmp_path, seconds=1.0):
    aid = _upload(client, tmp_path, duration=1.5)
    return client.post("/api/projects", json={"audio_id": aid, "recipe": SMALL,
                                              "seconds": seconds}).json()


def test_schema_endpoint(client):
    s = client.get("/api/schema/recipe").json()
    assert s["title"] == "Kaika recipe v2"
    vort = s["properties"]["field"]["properties"]["vorticity"]
    assert vort["ui"]["tier"] == "primary"
    assert vort["default"] == 8.0
    trig = s["properties"]["emitters"]["items"]["properties"]["trigger"]
    assert "onset" in trig["properties"]["type"]["enum"]


def test_signals_endpoint(client, tmp_path):
    data = _make_project(client, tmp_path)
    s = client.get(f"/api/projects/{data['run_id']}/signals?px=50").json()
    assert len(s["rms"]) <= 50
    assert set(s["bands"]) == {"low", "mid", "high"}
    assert "beats" in s and "sections" in s and "flux" in s


def test_patch_recipe_endpoint(client, tmp_path):
    data = _make_project(client, tmp_path)
    rid = data["run_id"]
    r = client.patch(f"/api/projects/{rid}/recipe", json={"ops": [
        {"op": "replace", "path": "/field/vorticity", "value": 42}]})
    assert r.status_code == 200
    assert r.json()["project"]["recipe"]["field"]["vorticity"] == 42
    # invalid patch -> 400 with the validation error, state unchanged
    r = client.patch(f"/api/projects/{rid}/recipe", json={"ops": [
        {"op": "add", "path": "/modulators/-",
         "value": {"source": "rms", "target": "field.nope"}}]})
    assert r.status_code == 400 and "field.nope" in r.text
    p = client.get(f"/api/projects/{rid}").json()
    assert p["project"]["recipe"]["field"]["vorticity"] == 42


def test_timeline_endpoint_and_validation(client, tmp_path):
    data = _make_project(client, tmp_path)
    rid = data["run_id"]
    tl = [{"at": 0.5, "action": "spawn", "count": 2}]
    r = client.patch(f"/api/projects/{rid}/timeline", json={"timeline": tl})
    assert r.status_code == 200
    assert r.json()["project"]["timeline"] == tl
    r = client.patch(f"/api/projects/{rid}/timeline",
                     json={"timeline": [{"action": "teleport"}]})
    assert r.status_code == 400


def test_revisions_and_restore(client, tmp_path):
    data = _make_project(client, tmp_path)
    rid = data["run_id"]
    client.patch(f"/api/projects/{rid}/recipe", json={"ops": [
        {"op": "replace", "path": "/field/vorticity", "value": 42}]})
    revs = client.get(f"/api/projects/{rid}/revisions").json()
    assert len(revs) == 1
    r = client.post(f"/api/projects/{rid}/revisions/0/restore")
    assert r.status_code == 200
    p = client.get(f"/api/projects/{rid}").json()
    assert (p["project"]["recipe"]["field"]["vorticity"]
            == 8.0)                                # back to the default


def test_settings_roundtrip_masks_secrets(client):
    r = client.put("/api/settings", json={"llm_provider": "gemini",
                                          "gemini_api_key": "secret-123"})
    assert r.status_code == 200
    s = client.get("/api/settings").json()
    assert s["llm_provider"] == "gemini"
    assert s["gemini_api_key"] is True             # masked, never the value
    assert "secret-123" not in json.dumps(s)


def test_ui_pins_persist(client, tmp_path):
    data = _make_project(client, tmp_path)
    rid = data["run_id"]
    r = client.put(f"/api/projects/{rid}",
                   json={"ui_pins": ["field.vorticity", "render.exposure"]})
    assert r.status_code == 200
    p = client.get(f"/api/projects/{rid}").json()
    assert p["project"]["ui_pins"] == ["field.vorticity", "render.exposure"]


def test_chat_endpoint_fake_provider(client, tmp_path):
    client.put("/api/settings", json={"llm_provider": "fake"})
    data = _make_project(client, tmp_path)
    rid = data["run_id"]
    msg = ('CALL add_timeline_directive {"spec": {"at": 0.5, "action": "spawn", '
           '"count": 3, "placement": {"type": "line", "from": [0.25, 0.5], '
           '"to": [0.75, 0.5]}}}')
    with client.stream("POST", f"/api/projects/{rid}/chat",
                       json={"message": msg}) as r:
        assert r.status_code == 200
        events = [json.loads(line[6:]) for line in r.iter_lines()
                  if line.startswith("data: ")]
    types = [e["type"] for e in events]
    assert "tool_call" in types and "done" in types
    p = client.get(f"/api/projects/{rid}").json()
    assert p["project"]["timeline"][0]["count"] == 3
    hist = client.get(f"/api/projects/{rid}/chat").json()
    assert any(m["role"] == "user" for m in hist)


def test_chat_requires_api_key(client, tmp_path):
    client.put("/api/settings", json={"llm_provider": "anthropic",
                                      "anthropic_api_key": ""})
    data = _make_project(client, tmp_path)
    r = client.post(f"/api/projects/{data['run_id']}/chat",
                    json={"message": "hi"})
    assert r.status_code == 400
    assert "API key" in r.text


def test_window_preview_supersedes_previous(client, tmp_path, monkeypatch):
    """The second preview request MUST cancel the first (queued or running).
    The fake job spins until released, so the first one cannot slip to done
    before the second request lands — the cancel path is always exercised."""
    import threading
    import time

    release = threading.Event()

    def fake_preview(rd, t0, t1, draft=True, progress=None):
        while not release.is_set():
            progress("fluid", 0, 1)     # raises JobCancelled once superseded
            time.sleep(0.01)
        return None

    monkeypatch.setattr("kaika.server.app.run_window_preview", fake_preview)
    data = _make_project(client, tmp_path)
    rid = data["run_id"]
    j1 = client.post(f"/api/projects/{rid}/preview_window",
                     json={"t0": 0.0, "t1": 0.5}).json()["job_id"]
    j2 = client.post(f"/api/projects/{rid}/preview_window",
                     json={"t0": 0.5, "t1": 1.0}).json()["job_id"]
    deadline = time.time() + 10
    while time.time() < deadline:
        if client.get(f"/api/jobs/{j1}").json()["status"] == "cancelled":
            break
        time.sleep(0.05)
    assert client.get(f"/api/jobs/{j1}").json()["status"] == "cancelled"
    release.set()                       # let the second job finish
    done = _wait(client, j2)
    assert done["status"] == "done", done.get("error")
