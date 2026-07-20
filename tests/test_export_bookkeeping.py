"""The HD export's bookkeeping seam: what keeps a finished master reachable.

`routes/export.py` was the largest uncovered block in the repo (46%), and it is exactly
where "the export doesn't match the preview" and "my export vanished" bugs live. These
cover `_record_export` and the two status routes — the parts with real logic that do NOT
need a diffusion model or a GPU to reach.

Deliberately NOT coverage theatre: every assertion here is a property someone could break.
`_record_export` in particular has three non-obvious behaviours (dedup-then-append, a
`keep` bound, and swallowing its own errors) and each is load-bearing for `cache_gc`.
"""

from __future__ import annotations

import json

import pytest

from backend import render_jobs
from backend.routes import export as ex


@pytest.fixture
def analysis_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(ex, "ANALYSIS_DIR", tmp_path)
    return tmp_path


def _cache(analysis_dir, job="j1"):
    p = analysis_dir / f"{job}.json"
    return json.loads(p.read_text()) if p.exists() else {}


# --------------------------------------------------------------------------- #
# _record_export — the reason an export survives the GC sweep
# --------------------------------------------------------------------------- #


def test_records_the_stem_not_the_url(analysis_dir):
    """`cache_gc` matches on the cache STEM. Recording the url (or keeping `.mp4`) would
    make every export look unreachable and quietly collectable."""
    ex._record_export("j1", "/fluid/song_abc123.mp4")
    assert _cache(analysis_dir)["song_exports"] == ["song_abc123"]


def test_a_repeat_export_moves_to_the_end_instead_of_duplicating(analysis_dir):
    """Re-exporting an unchanged project hits the render cache and records the SAME stem.
    Without the dedup, `keep` would fill with one repeated entry and evict the genuinely
    distinct exports it exists to protect."""
    for _ in range(3):
        ex._record_export("j1", "/fluid/song_same.mp4")
    ex._record_export("j1", "/fluid/song_other.mp4")
    ex._record_export("j1", "/fluid/song_same.mp4")
    assert _cache(analysis_dir)["song_exports"] == ["song_other", "song_same"]


def test_keep_bounds_the_list_and_evicts_oldest_first(analysis_dir):
    for i in range(6):
        ex._record_export("j1", f"/fluid/song_{i}.mp4", keep=3)
    assert _cache(analysis_dir)["song_exports"] == ["song_3", "song_4", "song_5"]


def test_song_and_segment_exports_use_separate_lists(analysis_dir):
    """A segment HD render must not evict the whole-song master, or the thing the user
    waited ten minutes for ages out because they previewed four segments after it."""
    ex._record_export("j1", "/fluid/song_master.mp4")
    for i in range(3):
        ex._record_export("j1", f"/assets/seg_{i}.mp4", key="segment_exports", keep=2)
    got = _cache(analysis_dir)
    assert got["song_exports"] == ["song_master"]
    assert got["segment_exports"] == ["seg_1", "seg_2"]


def test_it_preserves_unrelated_analysis_keys(analysis_dir):
    """The analysis file is shared with the lyric/segment caches — a read-modify-write
    that dropped them would destroy alignment data as a side effect of exporting."""
    (analysis_dir / "j1.json").write_text(json.dumps({"lyric_lines": [{"text": "hi"}]}))
    ex._record_export("j1", "/fluid/song_x.mp4")
    got = _cache(analysis_dir)
    assert got["lyric_lines"] == [{"text": "hi"}]
    assert got["song_exports"] == ["song_x"]


def test_a_corrupt_analysis_file_does_not_break_the_export(analysis_dir):
    """Best-effort by design: the render already succeeded and the user has their file.
    Failing here would turn a bookkeeping problem into a failed export."""
    (analysis_dir / "j1.json").write_text("{not json")
    ex._record_export("j1", "/fluid/song_x.mp4")  # must not raise


def test_an_unwritable_cache_dir_does_not_break_the_export(analysis_dir, monkeypatch):
    monkeypatch.setattr(ex, "ANALYSIS_DIR", analysis_dir / "nope" / "deeper")
    ex._record_export("j1", "/fluid/song_x.mp4")  # must not raise


# --------------------------------------------------------------------------- #
# the poll/cancel contract the frontend drives
# --------------------------------------------------------------------------- #


def test_status_404s_an_unknown_render(client):
    assert client.get("/export/stream/nope-not-a-render").status_code == 404


def test_status_returns_the_job_state(client):
    rid = render_jobs.start(lambda on_progress, should_cancel: "/fluid/x.mp4")
    body = client.get(f"/export/stream/{rid}").get_json()
    # the shape the frontend's poll loop destructures
    for field in ("error", "frames_done", "phase", "preview_url"):
        assert field in body, f"the status payload lost {field!r}"


def test_cancel_is_idempotent_and_never_404s(client):
    """The UI fires cancel on unmount, so it routinely arrives for a render that already
    finished — or never existed. That must be a no-op, not an error the user sees."""
    rid = render_jobs.start(lambda on_progress, should_cancel: "/fluid/x.mp4")
    for target in (rid, rid, "never-existed"):
        r = client.post(f"/export/stream/{target}/cancel")
        assert r.status_code == 200 and r.get_json() == {"ok": True}
