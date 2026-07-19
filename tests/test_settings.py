"""App-level settings (data/settings.json) + the /settings routes + the remote-inference
gate every diffusion call consults."""

import json

import pytest

from backend import paths, settings


@pytest.fixture
def settings_file(tmp_path, monkeypatch):
    """Point the settings store at a scratch file (late-bound via backend.paths)."""
    f = tmp_path / "settings.json"
    monkeypatch.setattr(paths, "SETTINGS_FILE", f)
    return f


def test_defaults_when_no_file(settings_file):
    s = settings.get_settings()
    assert s["inference"]["enabled"] is False
    assert s["inference"]["ops"] == {"stylize": True, "imagegen": True, "depth": False}


def test_corrupt_file_yields_defaults(settings_file):
    settings_file.write_text("{not json")
    assert settings.get_settings()["inference"]["enabled"] is False


def test_update_persists_and_drops_unknown_keys(settings_file):
    out = settings.update_settings(
        {"inference": {"enabled": True, "url": "http://gpu:5100", "junk": 1}, "nope": {}}
    )
    assert out["inference"]["enabled"] is True and out["inference"]["url"] == "http://gpu:5100"
    assert "junk" not in out["inference"] and "nope" not in out
    on_disk = json.loads(settings_file.read_text())
    assert on_disk["inference"]["url"] == "http://gpu:5100"
    # untouched keys keep their defaults
    assert out["inference"]["ops"]["stylize"] is True


def test_remote_endpoint_gating(settings_file, monkeypatch):
    monkeypatch.delenv("KAIKA_FORCE_LOCAL", raising=False)  # may be pinned by remote_app's import
    # off by default
    assert settings.remote_endpoint("stylize") is None
    settings.update_settings(
        {"inference": {"enabled": True, "url": " http://gpu:5100/ ", "token": " t "}}
    )
    # enabled + url + op on → endpoint, trimmed and unslashed
    assert settings.remote_endpoint("stylize") == ("http://gpu:5100", "t")
    # op toggled off → None (per-op switch)
    settings.update_settings({"inference": {"ops": {"stylize": False}}})
    assert settings.remote_endpoint("stylize") is None
    assert settings.remote_endpoint("imagegen") == ("http://gpu:5100", "t")
    # unknown op never routes
    assert settings.remote_endpoint("demucs") is None
    # the remote box pins itself local (anti-loop guard)
    monkeypatch.setenv("KAIKA_FORCE_LOCAL", "1")
    assert settings.remote_endpoint("imagegen") is None


def test_settings_routes_roundtrip(client, settings_file):
    r = client.get("/settings")
    assert r.status_code == 200 and r.get_json()["inference"]["enabled"] is False
    r = client.put("/settings", json={"inference": {"enabled": True, "url": "http://x:1"}})
    assert r.status_code == 200 and r.get_json()["inference"]["enabled"] is True
    assert client.get("/settings").get_json()["inference"]["url"] == "http://x:1"


def test_test_remote_requires_a_url(client, settings_file):
    r = client.post("/settings/test-remote", json={})
    assert r.status_code == 400
