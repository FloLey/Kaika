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


# --------------------------------------------------------------------------- #
# The HD stylize cache key (step 19b)
# --------------------------------------------------------------------------- #
# The key moved from "a sample of the rendered input frames" to a graph hash, which is
# what lets the export check the cache BEFORE rendering the input (676ms -> 0.1ms on a
# 15s segment). The risk of that swap is entirely one-directional: a key that is too
# STABLE serves a stale clip for an edited graph, silently and forever.


def _stylize_graph(*, radius=0.08, prompt="flowers"):
    from helpers import edge, graph_of, node

    ports = {
        k: {"binding": {"kind": "const", "value": v}}
        for k, v in [("r", 0.27), ("g", 0.69), ("b", 1), ("emit", 0.5), ("radius", radius)]
    }
    return graph_of(
        [
            node("fl", "fluid", ports=ports),
            node(
                "sty",
                "stylize",
                prompt=prompt,
                ports={"strength": {"binding": {"kind": "const", "value": 0.5}}},
            ),
            node("out", "output"),
        ],
        [edge("fl", "sty", "video"), edge("sty", "out", "video")],
    )


def _key_inputs(graph, seg, out_dict):
    """What `_regenerate_hd_stylize` folds into the key, without the diffusion model."""
    from backend import graph_hash
    from backend.graph_render import stylize_describe
    from helpers import no_audio

    src_id, ctrl_id, strength, _fps = stylize_describe("j", seg, graph, "sty", no_audio, out_dict)
    return (
        strength,
        ctrl_id,
        graph_hash.output_hash("j", seg, graph, src_id, out_dict),
    )


def test_the_stylize_key_moves_when_its_upstream_does():
    """An edit upstream of the stylize node changes what it would generate FROM, so the
    cached clip must not be reused. This is the direction that matters: too-stable keys
    serve a wrong clip; too-volatile keys merely re-render."""
    from helpers import out

    seg = {"start": 0.0, "end": 1.0, "signals": []}
    o = out(width=192, height=192, fps=12)
    a = _key_inputs(_stylize_graph(radius=0.08), seg, o)
    b = _key_inputs(_stylize_graph(radius=0.20), seg, o)
    assert a != b, "an upstream edit left the HD stylize key unchanged"


def test_the_stylize_key_is_stable_for_an_unchanged_graph():
    from helpers import out

    seg = {"start": 0.0, "end": 1.0, "signals": []}
    o = out(width=192, height=192, fps=12)
    assert _key_inputs(_stylize_graph(), seg, o) == _key_inputs(_stylize_graph(), seg, o)


def test_the_stylize_key_moves_with_the_segment_window():
    """Same graph, different slice of the song — different frames, so a different clip."""
    from helpers import out

    o = out(width=192, height=192, fps=12)
    g = _stylize_graph()
    a = _key_inputs(g, {"start": 0.0, "end": 1.0, "signals": []}, o)
    b = _key_inputs(g, {"start": 4.0, "end": 5.0, "signals": []}, o)
    assert a != b, "the key ignores which part of the song it renders"


def test_describe_is_consistent_with_what_the_render_returns():
    """`stylize_describe` exists only to avoid calling `stylize_source`, so the values it
    reports must be the ones the render would have produced. If they drift, the cache is
    keyed on one thing and the clip generated with another."""
    from backend.graph_render import stylize_describe, stylize_source
    from helpers import no_audio, out

    seg = {"start": 0.0, "end": 1.0, "signals": []}
    o = out(width=192, height=192, fps=12)
    g = _stylize_graph()
    src_id, ctrl_id, strength, fps = stylize_describe("j", seg, g, "sty", no_audio, o)
    frames, r_strength, r_fps, control = stylize_source("j", seg, g, "sty", no_audio, o)
    assert (strength, fps) == (r_strength, r_fps)
    assert (ctrl_id is not None) == (control is not None)
    assert src_id == "fl" and len(frames) > 0
