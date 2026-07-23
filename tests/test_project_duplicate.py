"""POST /projects/<id>/duplicate — an independent copy of a project.

Pinned: the new row exists under a fresh id with " (copy)" on the title and every
job-scoped URL in its data rewritten onto the new id; the per-job files arrive as
HARDLINKS (same inode — instant, no extra disk, and they survive deleting the
original); an unknown source 404s.
"""

import pytest

from backend import db, paths


@pytest.fixture
def project(live_db):
    db.create_project(
        "aaaa1111",
        title="Test song",
        source="test.mp3",
        duration=10.0,
        fmin=20,
        has_lyrics=False,
        stems={"drums": {"sr": 44100, "audio": "/audio/aaaa1111/drums"}},
    )
    # A doc with job-scoped urls in the shapes the app writes.
    row = db.get_project("aaaa1111")
    data = row["data"]
    data["assets"] = [{"id": "a1", "url": "/assets/aaaa1111/deadbeefdeadbeef.mp4"}]
    db.save_segments("aaaa1111", segments=[], compositions={})
    with db._connect() as conn:
        from psycopg.types.json import Jsonb

        conn.execute("UPDATE projects SET data=%s WHERE job_id=%s", (Jsonb(data), "aaaa1111"))
    # …and per-job files to link.
    src = paths.ASSETS_DIR / "aaaa1111"
    src.mkdir(parents=True, exist_ok=True)
    (src / "deadbeefdeadbeef.mp4").write_bytes(b"fake clip")
    yield "aaaa1111"
    db.delete_project("aaaa1111")


def test_duplicate_copies_row_and_hardlinks_files(client, project):
    r = client.post(f"/projects/{project}/duplicate")
    assert r.status_code == 200, r.get_json()
    new_id = r.get_json()["job_id"]
    try:
        assert new_id != project and len(new_id) == 8
        row = db.get_project(new_id)
        assert row["title"] == "Test song (copy)"
        # Every job-scoped url rewritten onto the new id.
        assert row["data"]["assets"][0]["url"] == f"/assets/{new_id}/deadbeefdeadbeef.mp4"
        assert row["data"]["stems"]["drums"]["audio"] == f"/audio/{new_id}/drums"
        # Files are HARDLINKS of the originals: same inode, no bytes copied.
        a = paths.ASSETS_DIR / project / "deadbeefdeadbeef.mp4"
        b = paths.ASSETS_DIR / new_id / "deadbeefdeadbeef.mp4"
        assert b.is_file() and a.stat().st_ino == b.stat().st_ino
        # …and the link keeps the file alive if the ORIGINAL is deleted.
        client.delete(f"/projects/{project}")
        assert b.is_file() and b.read_bytes() == b"fake clip"
    finally:
        db.delete_project(new_id)


def test_duplicate_unknown_project_404s(client, live_db):
    assert client.post("/projects/ffffeeee/duplicate").status_code == 404
