"""The Playground fixture export (💾 save-fixture button / `make export-playground`):
capture the live playground project into the committed pipelines file. Both the target
FILE and the project id are patched — a test must never overwrite the real fixture."""

import json

import pytest

pytest.importorskip("torch")

from backend import card_demo, seed_card_demo  # noqa: E402


@pytest.fixture
def scratch_playground(live_db, tmp_path, monkeypatch):
    """A scratch 'playground' project + a tmp fixture path."""
    from backend import db

    job = "pgexp001"
    monkeypatch.setattr(seed_card_demo, "JOB_ID", job)
    fixture = tmp_path / "pipelines.json"
    monkeypatch.setattr(card_demo, "PIPELINES_PATH", fixture)
    db.delete_project(job)
    db.create_project(job, title="t", source="s", duration=1.0, fmin=20, has_lyrics=False, stems={})
    segs = [
        {
            "id": "s1",
            "label": "Fluid",
            "signals": [{"id": "sig-used", "name": "u"}, {"id": "sig-unused", "name": "x"}],
            "rootCompositionId": "c-s1",
        },
        {
            "id": "s2",
            "label": "My Experiment",
            "signals": [],  # not a card name
            "rootCompositionId": "c-s2",
        },
    ]
    pool = {
        "c-s1": {
            "id": "c-s1",
            "name": "Fluid",
            "graph": {
                "version": 22,
                "edges": [],
                "nodes": [
                    {"id": "f", "type": "fluid", "data": {}},
                    {"id": "sg", "type": "signal", "data": {"signalId": "sig-used"}},
                ],
            },
        },
        "c-s2": {
            "id": "c-s2",
            "name": "My Experiment",
            "graph": {
                "version": 22,
                "edges": [],
                "nodes": [{"id": "x", "type": "fluid", "data": {}}],
            },
        },
    }
    db.save_segments(job, segs, compositions=pool)
    yield job, fixture
    db.delete_project(job)


def test_export_writes_fixture_and_reports(scratch_playground):
    job, fixture = scratch_playground
    summary = seed_card_demo.export_playground()
    assert summary["exported"] == 1
    assert summary["skipped"] == ["My Experiment"]  # unknown labels reported, not exported
    assert "lyrics" in summary["missing"]  # scratch project covers 1 card — the rest is missing
    data = json.loads(fixture.read_text())
    assert [p["key"] for p in data] == ["fluid"]
    # hydration noise pruned: only the signal the graph references survives
    assert [s["id"] for s in data[0]["signals"]] == ["sig-used"]


def test_export_without_playground_raises_lookup(live_db, monkeypatch, tmp_path):
    monkeypatch.setattr(seed_card_demo, "JOB_ID", "zz99nope")
    monkeypatch.setattr(card_demo, "PIPELINES_PATH", tmp_path / "p.json")
    with pytest.raises(LookupError):
        seed_card_demo.export_playground()


def test_export_route(client, live_db, monkeypatch, scratch_playground):
    r = client.post("/playground/export")
    assert r.status_code == 200
    body = r.get_json()
    assert body["exported"] == 1 and body["skipped"] == ["My Experiment"]


def test_export_route_404_when_no_playground(client, live_db, monkeypatch, tmp_path):
    monkeypatch.setattr(seed_card_demo, "JOB_ID", "zz99nope")
    monkeypatch.setattr(card_demo, "PIPELINES_PATH", tmp_path / "p.json")
    r = client.post("/playground/export")
    assert r.status_code == 404 and "zz99nope" in r.get_json()["error"]


# --------------------------------------------------------------------------- #
# The additive demo sync: opening the Playground appends demos for NEW cards and
# never touches the user's existing segments (no destructive reseed needed).
# --------------------------------------------------------------------------- #
@pytest.fixture
def sync_playground(live_db, tmp_path, monkeypatch):
    """A scratch playground that already has one (reworked) segment, plus a fixture
    holding that card AND one new card the live project lacks. Stem/analysis writes
    are stubbed out — the sync's file side-effects aren't under test here."""
    from backend import db

    job = "pgsync001"
    monkeypatch.setattr(seed_card_demo, "JOB_ID", job)
    monkeypatch.setattr(seed_card_demo, "write_synthetic_stems", lambda *a, **k: {})
    monkeypatch.setattr(seed_card_demo, "write_analysis", lambda *a, **k: [])
    # the live project already has a REWORKED Fluid segment (user edits must survive)
    db.delete_project(job)
    db.create_project(job, title="t", source="s", duration=3.0, fmin=20, has_lyrics=False, stems={})
    reworked = {
        "id": "s1",
        "label": "Fluid",
        "signals": [],
        "start": 0.0,
        "end": 3.0,
        "graph": {
            "version": 24,
            "edges": [],
            "nodes": [{"id": "f", "type": "fluid", "data": {"user": "rework"}}],
        },
    }
    db.save_segments(job, [reworked])
    demos = [
        {
            "key": "fluid",
            "label": "Fluid",
            "signals": [],
            "graph": {
                "version": 24,
                "edges": [],
                "nodes": [{"id": "f", "type": "fluid", "data": {}}],
            },
        },
        {
            "key": "echo",
            "label": "Echo",
            "signals": [],
            "graph": {
                "version": 24,
                "edges": [],
                "nodes": [{"id": "e", "type": "echo", "data": {}}],
            },
        },
    ]
    monkeypatch.setattr(card_demo, "DEMOS", demos)
    yield job
    db.delete_project(job)


def test_sync_appends_only_the_missing_demo_and_keeps_rework(sync_playground):
    from backend import db

    appended = seed_card_demo._append_missing_demos(db)
    assert appended == ["Echo"]
    row = db.get_project(sync_playground)
    segs = row["data"]["segments"]
    assert [s["label"] for s in segs] == ["Fluid", "Echo"]
    # the user's rework survived byte-for-byte
    assert segs[0]["graph"]["nodes"][0]["data"] == {"user": "rework"}
    # the new demo lands AFTER the existing timeline and the song grew to cover it
    assert segs[1]["start"] == 3.0 and segs[1]["end"] == 6.0
    assert float(row["duration"]) == 6.0


def test_sync_is_a_noop_when_every_card_has_a_segment(sync_playground):
    from backend import db

    seed_card_demo._append_missing_demos(db)
    before = db.get_project(sync_playground)["data"]["segments"]
    assert seed_card_demo._append_missing_demos(db) == []  # second run: nothing to add
    assert db.get_project(sync_playground)["data"]["segments"] == before


def test_export_is_additive_and_keeps_prior_fixture_entries(scratch_playground):
    """The data-loss guard: a stale/partial rail (here: only Fluid) must not erase
    other cards' demos from the fixture — prior entries are KEPT, not dropped."""
    from backend import seed_card_demo

    job, fixture = scratch_playground
    fixture.write_text(
        json.dumps(
            [
                {
                    "key": "echo",
                    "label": "Echo",
                    "signals": [],
                    "graph": {
                        "version": 24,
                        "edges": [],
                        "nodes": [{"id": "e", "type": "echo", "data": {}}],
                    },
                },
                {
                    "key": "fluid",
                    "label": "Fluid",
                    "signals": [],
                    "graph": {
                        "version": 24,
                        "edges": [],
                        "nodes": [{"id": "old", "type": "fluid", "data": {}}],
                    },
                },
            ]
        )
    )
    summary = seed_card_demo.export_playground()
    assert summary["exported"] == 1 and summary["kept"] == ["echo"]
    assert "echo" not in summary["missing"]
    data = {p["key"]: p for p in json.loads(fixture.read_text())}
    assert set(data) == {"fluid", "echo"}
    # the LIVE fluid segment overrode the prior fixture entry; echo was preserved
    assert data["fluid"]["graph"]["nodes"][0]["id"] == "f"
    assert data["echo"]["graph"]["nodes"][0]["id"] == "e"
