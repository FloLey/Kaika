"""Reachability GC for the render-clip cache.

Two guarantees: `reachable_hashes()` reproduces the frontend's `output_hash` exactly
(so the clips we KEEP are the ones a project actually replays — including the lyric
text a lyrics node bakes in), and `sweep()` deletes only clips that are both
unreachable AND older than the recency window (so it never touches the session you're
editing), and bails entirely if the DB is unavailable.
"""

from __future__ import annotations

import json

import pytest

from backend import cache_gc
from backend import db
from backend import graph as G
from backend import paths

OUT = {"width": 96, "height": 128, "quality": "draft", "fps": 24, "background": "#101418"}


def _fluid(nid, color, pos):
    ports = {k: {"binding": {"kind": "const", "value": v}} for k, v in
             [("r", color[0]), ("g", color[1]), ("b", color[2]), ("force", 42), ("emit", 0.4)]}
    return {"id": nid, "type": "fluid", "data": {"static": {"points": [pos]}, "ports": ports}}


def _edge(s, t, tp):
    return {"id": s + t + tp, "source": s, "sourcePort": "out", "target": t, "targetPort": tp}


def _project(job_id):
    """A project with one segment: fluid -> lyrics-stacked -> two output nodes."""
    graph = {"version": 1, "nodes": [
        _fluid("f1", (0.3, 0.7, 1.0), [0.5, 0.5]),
        {"id": "ly", "type": "lyrics", "data": {"position": "bottom", "ports": {}}},
        {"id": "cb", "type": "combine", "data": {"mode": "stack",
         "inputs": [{"id": "s0", "opacity": 1.0}, {"id": "s1", "opacity": 1.0}], "medium": {}}},
        {"id": "oA", "type": "output", "data": {}},
        {"id": "oB", "type": "output", "data": {}},
    ], "edges": [
        _edge("ly", "cb", "s0"), _edge("f1", "cb", "s1"),
        _edge("cb", "oA", "video"), _edge("cb", "oB", "video"),
    ]}
    segment = {"id": "seg-0", "start": 0.0, "end": 2.0, "signals": [], "graph": graph}
    return {"job_id": job_id, "data": {"output": OUT, "segments": [segment]}}


@pytest.fixture
def wired(tmp_path, monkeypatch):
    """One user project + an (empty) playground, with a temp analysis dir + cache dir."""
    proj = _project("proj1")
    monkeypatch.setattr(cache_gc, "ANALYSIS_DIR", tmp_path / "analysis")
    (tmp_path / "analysis").mkdir()
    # lyric lines live in the analysis cache — the same source the frontend uses.
    lines = [{"t0": 0.2, "t1": 1.5, "text": "les avions dessinent dans le ciel"}]
    (tmp_path / "analysis" / "proj1.json").write_text(json.dumps({"lyric_lines": lines}))

    monkeypatch.setattr(db, "get_projects_full", lambda: [proj])
    monkeypatch.setattr(paths, "ANIM_DIR", tmp_path / "fluid")
    (tmp_path / "fluid").mkdir()
    monkeypatch.setattr(cache_gc, "ASSETS_DIR", tmp_path / "assets")
    (tmp_path / "assets").mkdir()
    monkeypatch.setattr(cache_gc, "_last_run", 0.0)
    return proj, lines, tmp_path


def test_reachable_matches_output_hash_including_lyrics(wired):
    proj, lines, _ = wired
    seg = proj["data"]["segments"][0]
    seg_with_lines = {**seg, "lyric_lines": lines}
    expected = {
        G.output_hash("proj1", seg_with_lines, seg["graph"], oid, OUT) for oid in ("oA", "oB")
    }
    assert cache_gc.reachable_hashes() == expected
    assert len(expected) == 2  # one key per output node


def test_sweep_keeps_reachable_and_recent_deletes_the_rest(wired):
    _, _, tmp = wired
    fluid_dir = tmp / "fluid"
    reachable = next(iter(cache_gc.reachable_hashes()))
    keep = fluid_dir / f"{reachable}.mp4"          # referenced by the project
    recent = fluid_dir / "deadbeefdeadbeef.mp4"    # junk, but just rendered
    stale = fluid_dir / "0123456789abcdef.mp4"     # junk, old
    for p in (keep, recent, stale):
        p.write_bytes(b"x")
    import os
    old = cache_gc.KEEP_RECENT_SEC + 3600
    os.utime(stale, (os.stat(stale).st_atime, os.stat(stale).st_mtime - old))

    removed = cache_gc.sweep()
    assert removed == 1
    assert keep.exists() and recent.exists() and not stale.exists()


def test_sweep_reaps_unreferenced_assets(wired):
    proj, _, tmp = wired
    assets_dir = tmp / "assets"
    proj["data"]["assets"] = [{"url": "/assets/proj1/pic.png"}]
    referenced = assets_dir / "proj1" / "pic.png"   # in the project's asset library
    orphan = assets_dir / "junk" / "old.png"        # no project references it
    for p in (referenced, orphan):
        p.parent.mkdir(exist_ok=True)
        p.write_bytes(b"x")
    import os
    old = cache_gc.KEEP_RECENT_SEC + 3600
    for p in (referenced, orphan):
        os.utime(p, (os.stat(p).st_atime, os.stat(p).st_mtime - old))

    removed = cache_gc.sweep()
    assert removed == 1
    assert referenced.exists() and not orphan.exists()
    assert not orphan.parent.exists()  # emptied per-job dir is pruned


def test_sweep_bails_when_db_unavailable(wired, monkeypatch):
    _, _, tmp = wired
    stale = tmp / "fluid" / "0123456789abcdef.mp4"
    stale.write_bytes(b"x")
    import os
    os.utime(stale, (0, 0))  # ancient

    def boom():
        raise db.DBUnavailable("postgres down")

    monkeypatch.setattr(db, "get_projects_full", boom)
    monkeypatch.setattr(cache_gc, "_last_run", 0.0)
    assert cache_gc.sweep() == 0
    assert stale.exists()  # a DB outage must NOT be read as "nothing is reachable"
