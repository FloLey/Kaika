"""Shared fixtures for the backend test suite."""

import pytest


@pytest.fixture(autouse=True)
def _isolated_frame_cache(tmp_path, monkeypatch):
    """Every test renders against its OWN raw-frame cache dir. A test must neither
    read from nor pollute the developer's real `data/fluid_cache` — the montage's
    per-slot cache made that concrete: two tests rendering the same graph would have
    served each other stale frames, and a suite run would leave entries behind."""
    from backend import fluid_cache

    monkeypatch.setattr(fluid_cache, "CACHE_DIR", tmp_path / "fluid_cache")


@pytest.fixture
def client():
    """A Flask test client on the full app. Importing the app pulls in the ML stack,
    so skip (not fail) where torch isn't installed (e.g. the minimal CI image)."""
    pytest.importorskip("torch")
    from backend.app import app

    app.config["TESTING"] = True
    return app.test_client()


@pytest.fixture
def live_db():
    """Guard for tests that need a reachable Postgres: init the schema or skip."""
    from backend import db

    try:
        db.init_schema()
    except db.DBUnavailable:
        pytest.skip("no database reachable")
