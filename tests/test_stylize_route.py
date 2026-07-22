"""The /stylize job's server-side write-back: an HD clip takes tens of minutes, so the
finished asset must land on its node in the DB even if the tab (the only other writer)
closed mid-job."""

import pytest

pytest.importorskip("torch")

from backend.routes.stylize import _persist_asset_url  # noqa: E402

URL = "/assets/ab12cd34/stylize-test.mp4"


def _segments():
    return [{"id": "seg1", "label": "AI Stylize", "rootCompositionId": "c1"}]


def _pool():
    return {
        "c1": {
            "id": "c1",
            "name": "AI Stylize",
            "graph": {
                "version": 22,
                "nodes": [
                    {"id": "fl", "type": "fluid", "data": {}},
                    {"id": "st", "type": "stylize", "data": {"assetUrl": "/assets/old.mp4"}},
                    {"id": "st2", "type": "extract", "data": {}},  # same-graph decoy
                ],
                "edges": [],
            },
        }
    }


def test_persist_asset_url_lands_on_the_node(live_db):
    from backend import db

    job = "ab12cd34"
    db.delete_project(job)
    db.create_project(job, title="t", source="s", duration=1.0, fmin=20, has_lyrics=False, stems={})
    try:
        db.save_segments(job, _segments(), compositions=_pool())
        _persist_asset_url(job, "st", URL)
        comp = db.get_project(job)["data"]["compositions"]["c1"]
        by_id = {n["id"]: n for n in comp["graph"]["nodes"]}
        assert by_id["st"]["data"]["assetUrl"] == URL
        assert "assetUrl" not in by_id["st2"]["data"]  # non-stylize node untouched
    finally:
        db.delete_project(job)


def test_persist_asset_url_survives_missing_project_and_node(live_db):
    from backend import db

    # No such project: must be a silent no-op, never an exception (the job is finishing).
    _persist_asset_url("zz99zz99", "st", URL)

    job = "ab12cd34"
    db.delete_project(job)
    db.create_project(job, title="t", source="s", duration=1.0, fmin=20, has_lyrics=False, stems={})
    try:
        db.save_segments(job, _segments(), compositions=_pool())
        _persist_asset_url(job, "deleted-mid-job", URL)  # node gone: graph left as-is
        comp = db.get_project(job)["data"]["compositions"]["c1"]
        assert {n["id"]: n for n in comp["graph"]["nodes"]}["st"]["data"][
            "assetUrl"
        ] == "/assets/old.mp4"
    finally:
        db.delete_project(job)
