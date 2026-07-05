"""Editing aligned lyric line TEXT via PUT /projects (the rewritten-lyrics flow).

The timings stay locked to the vocal (only Whisper alignment can produce them);
the edited lines overwrite the analysis cache — the same file `project_get`
serves them from — so every consumer (card preview, render keys, export hash)
sees the new words. Postgres-backed: skips when no DB is reachable.
"""

import json

import pytest

pytest.importorskip("torch")  # importing backend.app pulls torch

from backend import db  # noqa: E402


def _mk_project(job):
    db.delete_project(job)
    db.create_project(
        job, title="t", source="s", duration=1.0, fmin=20, has_lyrics=True, stems={}
    )


@pytest.fixture
def analysis_dir(tmp_path, monkeypatch):
    from backend.routes import projects as projects_routes

    monkeypatch.setattr(projects_routes, "ANALYSIS_DIR", tmp_path)
    return tmp_path


def test_put_lyric_lines_rewrites_text_and_keeps_other_analysis(client, live_db, analysis_dir):
    job = "test-lyr-0001"
    _mk_project(job)
    # Seed the analysis cache the way /segment leaves it: lines + other keys.
    (analysis_dir / f"{job}.json").write_text(
        json.dumps(
            {
                "lyric_lines": [{"t0": 1.0, "t1": 2.0, "text": "old words", "aligned": True}],
                "vocal_envelope": [0.1, 0.9],
            }
        )
    )

    new_lines = [{"t0": 1.0, "t1": 2.0, "text": "her new words", "aligned": True}]
    r = client.put(f"/projects/{job}", json={"segments": [], "lyric_lines": new_lines})
    assert r.status_code == 200

    saved = json.loads((analysis_dir / f"{job}.json").read_text())
    assert saved["lyric_lines"] == new_lines
    assert saved["vocal_envelope"] == [0.1, 0.9]  # other analysis keys survive

    # GET serves the edited lines back (what App.tsx loads on resume).
    got = client.get(f"/projects/{job}").get_json()
    assert got["lyric_lines"][0]["text"] == "her new words"


def test_put_without_lyric_lines_leaves_them_alone(client, live_db, analysis_dir):
    job = "test-lyr-0002"
    _mk_project(job)
    (analysis_dir / f"{job}.json").write_text(
        json.dumps({"lyric_lines": [{"t0": 0.0, "t1": 1.0, "text": "keep me"}]})
    )
    # A normal autosave PUT (no lyric_lines key) must not touch the cache.
    r = client.put(f"/projects/{job}", json={"segments": [], "step": "studio"})
    assert r.status_code == 200
    saved = json.loads((analysis_dir / f"{job}.json").read_text())
    assert saved["lyric_lines"][0]["text"] == "keep me"


def test_put_lyric_lines_coerces_and_drops_junk(client, live_db, analysis_dir):
    job = "test-lyr-0003"
    _mk_project(job)
    r = client.put(
        f"/projects/{job}",
        json={
            "segments": [],
            "lyric_lines": [
                {"t0": "1.5", "t1": 2, "text": 42},  # coercible types
                "not a dict",  # dropped
            ],
        },
    )
    assert r.status_code == 200
    saved = json.loads((analysis_dir / f"{job}.json").read_text())
    assert saved["lyric_lines"] == [{"t0": 1.5, "t1": 2.0, "text": "42"}]
