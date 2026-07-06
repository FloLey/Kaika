"""Project persistence tests (B8.2).

`migrate_project_data` is pure and always runs. The Postgres round-trip skips when
no database is reachable (CI without a DB service), so it exercises real SQL locally
without failing elsewhere.
"""

import pytest

from backend import db


def test_migrate_stamps_schema_version_on_unversioned_blob():
    out = db.migrate_project_data({"stems": {}, "segments": []})
    assert out["schema_version"] == db.SCHEMA_VERSION
    assert out["stems"] == {} and out["segments"] == []


def test_migrate_handles_none():
    assert db.migrate_project_data(None)["schema_version"] == db.SCHEMA_VERSION


def test_migrate_is_idempotent():
    once = db.migrate_project_data({"segments": []})
    twice = db.migrate_project_data(once)
    assert once == twice


# `live_db` comes from conftest.py.


def test_project_round_trip(live_db):
    job = "test-rt-0001"
    db.delete_project(job)
    db.create_project(
        job,
        title="t",
        source="s",
        duration=1.0,
        fmin=20,
        has_lyrics=False,
        stems={"drums": {"sr": 44100}},
    )
    try:
        row = db.get_project(job)
        assert row["title"] == "t"
        assert row["data"]["schema_version"] == db.SCHEMA_VERSION
        assert row["data"]["stems"]["drums"]["sr"] == 44100

        segs = [{"id": "seg-0", "start": 0.0, "end": 1.0, "signals": []}]
        assert db.save_segments(job, segs, step="studio", output={"width": 800})
        row = db.get_project(job)
        assert row["step"] == "studio"
        assert row["data"]["segments"] == segs
        assert row["data"]["output"]["width"] == 800
        assert row["data"]["schema_version"] == db.SCHEMA_VERSION

        assert any(p["job_id"] == job for p in db.list_projects())
    finally:
        assert db.delete_project(job)
        assert db.get_project(job) is None


def test_list_projects_excludes_the_playground(live_db):
    # The app-managed Playground must never appear among the user's projects, but is
    # still openable directly via get_project. NON-DESTRUCTIVE against the shared dev
    # DB: only create (and clean up) a playground row if none exists — this test used
    # to unconditionally delete the REAL seeded Playground on every suite run.
    created = False
    if db.get_project("playground") is None:
        db.create_project(
            "playground", title="Playground", source="synthetic", duration=1.0, fmin=20,
            has_lyrics=False, stems={},
        )
        created = True
    try:
        listed = {p["job_id"] for p in db.list_projects()}
        assert "playground" not in listed
        assert db.get_project("playground") is not None  # still openable directly
    finally:
        if created:
            db.delete_project("playground")
