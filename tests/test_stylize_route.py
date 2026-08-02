"""The /stylize job's server-side write-back: an HD clip takes tens of minutes, so the
finished asset must land on its node in the DB even if the tab (the only other writer)
closed mid-job."""

import pytest

pytest.importorskip("torch")

from backend.routes._node_assets import persist_asset_url  # noqa: E402

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
        persist_asset_url(job, "st", "stylize", URL)
        comp = db.get_project(job)["data"]["compositions"]["c1"]
        by_id = {n["id"]: n for n in comp["graph"]["nodes"]}
        assert by_id["st"]["data"]["assetUrl"] == URL
        assert "assetUrl" not in by_id["st2"]["data"]  # non-stylize node untouched
    finally:
        db.delete_project(job)


def test_persist_asset_url_survives_missing_project_and_node(live_db):
    from backend import db

    # No such project: must be a silent no-op, never an exception (the job is finishing).
    persist_asset_url("zz99zz99", "st", "stylize", URL)

    job = "ab12cd34"
    db.delete_project(job)
    db.create_project(job, title="t", source="s", duration=1.0, fmin=20, has_lyrics=False, stems={})
    try:
        db.save_segments(job, _segments(), compositions=_pool())
        persist_asset_url(job, "deleted-mid-job", "stylize", URL)  # node gone: graph left as-is
        comp = db.get_project(job)["data"]["compositions"]["c1"]
        assert {n["id"]: n for n in comp["graph"]["nodes"]}["st"]["data"][
            "assetUrl"
        ] == "/assets/old.mp4"
    finally:
        db.delete_project(job)


def _shared_id_pool():
    """Two compositions holding the SAME node id — what copying a card between segments
    produces, and the shape the scoping exists for."""
    node = {"id": "n-dream1", "type": "dream", "data": {"assetUrl": "/assets/x/old.mp4"}}
    return {
        "c1": {"id": "c1", "graph": {"nodes": [dict(node, data=dict(node["data"]))], "edges": []}},
        "c2": {"id": "c2", "graph": {"nodes": [dict(node, data=dict(node["data"]))], "edges": []}},
    }


def _two_segments():
    return [
        {"id": "seg1", "label": "one", "rootCompositionId": "c1"},
        {"id": "seg2", "label": "two", "rootCompositionId": "c2"},
    ]


def _url_in(job, cid):
    from backend import db

    pool = (db.get_project(job).get("data") or {}).get("compositions") or {}
    return ((pool[cid]["graph"]["nodes"][0].get("data")) or {}).get("assetUrl")


def test_a_scoped_write_leaves_the_other_composition_alone(live_db):
    """The bug this scoping fixes: a card copied into nine segments keeps its node id, so
    an unscoped write puts ONE segment's clip on all nine — every segment then shows the
    same imagery, silently."""
    from backend import db

    job = "ab12cd35"
    db.delete_project(job)
    db.create_project(job, title="t", source="s", duration=1.0, fmin=20, has_lyrics=False, stems={})
    try:
        db.save_segments(job, _two_segments(), compositions=_shared_id_pool())
        persist_asset_url(job, "n-dream1", "dream", "/assets/x/new.mp4", composition_id="c1")
        assert _url_in(job, "c1") == "/assets/x/new.mp4"
        assert _url_in(job, "c2") == "/assets/x/old.mp4", "c2 must not inherit c1's clip"
    finally:
        db.delete_project(job)


def test_an_unscoped_write_still_reaches_every_copy(live_db):
    """Kept deliberately: callers that genuinely mean "wherever this node lives" rely on
    it, so the scoping must be opt-in rather than a change of default behaviour."""
    from backend import db

    job = "ab12cd36"
    db.delete_project(job)
    db.create_project(job, title="t", source="s", duration=1.0, fmin=20, has_lyrics=False, stems={})
    try:
        db.save_segments(job, _two_segments(), compositions=_shared_id_pool())
        persist_asset_url(job, "n-dream1", "dream", "/assets/x/new.mp4")
        assert _url_in(job, "c1") == "/assets/x/new.mp4"
        assert _url_in(job, "c2") == "/assets/x/new.mp4"
    finally:
        db.delete_project(job)


def test_an_unknown_composition_writes_nothing(live_db):
    """A composition deleted while a multi-hour export ran must not raise, and must not
    fall back to writing everywhere."""
    from backend import db

    job = "ab12cd37"
    db.delete_project(job)
    db.create_project(job, title="t", source="s", duration=1.0, fmin=20, has_lyrics=False, stems={})
    try:
        db.save_segments(job, _two_segments(), compositions=_shared_id_pool())
        persist_asset_url(job, "n-dream1", "dream", "/assets/x/new.mp4", composition_id="gone")
        assert _url_in(job, "c1") == "/assets/x/old.mp4"
        assert _url_in(job, "c2") == "/assets/x/old.mp4"
    finally:
        db.delete_project(job)
