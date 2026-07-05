"""Shared fixtures for the backend test suite."""

import pytest


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
