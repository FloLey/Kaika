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
    ports = {
        k: {"binding": {"kind": "const", "value": v}}
        for k, v in [
            ("r", color[0]),
            ("g", color[1]),
            ("b", color[2]),
            ("force", 42),
            ("emit", 0.4),
        ]
    }
    return {"id": nid, "type": "fluid", "data": {"static": {"points": [pos]}, "ports": ports}}


def _edge(s, t, tp):
    return {"id": s + t + tp, "source": s, "sourcePort": "out", "target": t, "targetPort": tp}


def _project(job_id):
    """A project with one segment: fluid -> lyrics-stacked -> two output nodes."""
    graph = {
        "version": 1,
        "nodes": [
            _fluid("f1", (0.3, 0.7, 1.0), [0.5, 0.5]),
            {"id": "ly", "type": "lyrics", "data": {"position": "bottom", "ports": {}}},
            {
                "id": "cb",
                "type": "combine",
                "data": {
                    "mode": "stack",
                    "inputs": [{"id": "s0", "opacity": 1.0}, {"id": "s1", "opacity": 1.0}],
                    "medium": {},
                },
            },
            {"id": "oA", "type": "output", "data": {}},
            {"id": "oB", "type": "output", "data": {}},
        ],
        "edges": [
            _edge("ly", "cb", "s0"),
            _edge("f1", "cb", "s1"),
            _edge("cb", "oA", "video"),
            _edge("cb", "oB", "video"),
        ],
    }
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
    keep = fluid_dir / f"{reachable}.mp4"  # referenced by the project
    recent = fluid_dir / "deadbeefdeadbeef.mp4"  # junk, but just rendered
    stale = fluid_dir / "0123456789abcdef.mp4"  # junk, old
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
    referenced = assets_dir / "proj1" / "pic.png"  # in the project's asset library
    orphan = assets_dir / "junk" / "old.png"  # no project references it
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


def test_sweep_keeps_recorded_song_exports(wired):
    # A finished whole-song HD export records its `song_<hash>` stem in the analysis
    # cache (routes/export._record_export) — the sweep must treat it as reachable
    # forever, not reap a multi-minute render as junk after 30 minutes.
    _, _, tmp = wired
    analysis = tmp / "analysis" / "proj1.json"
    data = json.loads(analysis.read_text())
    data["song_exports"] = ["song_feedc0defeedc0de"]
    analysis.write_text(json.dumps(data))

    fluid_dir = tmp / "fluid"
    export = fluid_dir / "song_feedc0defeedc0de.mp4"  # recorded -> kept
    junk = fluid_dir / "song_0000000000000000.mp4"  # unrecorded export junk -> reaped
    for p in (export, junk):
        p.write_bytes(b"x")
    import os

    old = cache_gc.KEEP_RECENT_SEC + 3600
    for p in (export, junk):
        os.utime(p, (os.stat(p).st_atime, os.stat(p).st_mtime - old))

    removed = cache_gc.sweep()
    assert removed == 1
    assert export.exists() and not junk.exists()


def test_sweep_keeps_recorded_segment_hd_renders(wired):
    # A single-segment HD render (the Output card's "HD" button) records BOTH its
    # silent clip and its audio-muxed sibling under `segment_exports`. Neither hash is
    # recomputable — the render uses the CLIENT's graph (possibly unsaved) and swaps HD
    # assets in memory — so the record is the only thing standing between a
    # multi-minute render and the sweep.
    _, _, tmp = wired
    analysis = tmp / "analysis" / "proj1.json"
    data = json.loads(analysis.read_text())
    data["segment_exports"] = ["abc123abc123abc1", "hd-abc123abc123abc1-orig"]
    analysis.write_text(json.dumps(data))

    fluid_dir = tmp / "fluid"
    silent = fluid_dir / "abc123abc123abc1.mp4"
    muxed = fluid_dir / "hd-abc123abc123abc1-orig.mp4"
    junk = fluid_dir / "ffffffffffffffff.mp4"  # an old unrecorded clip -> reaped
    for p in (silent, muxed, junk):
        p.write_bytes(b"x")
    import os

    old = cache_gc.KEEP_RECENT_SEC + 3600
    for p in (silent, muxed, junk):
        os.utime(p, (os.stat(p).st_atime, os.stat(p).st_mtime - old))

    removed = cache_gc.sweep()
    assert removed == 1
    assert silent.exists() and muxed.exists() and not junk.exists()


def test_reachable_recomputes_song_export_hash_when_final_outputs_marked(wired):
    # With every segment carrying a finalOutputId, the sweep can recompute the export
    # stem straight from the saved state (exact when no imagegen HD regen happened).
    from backend import song_render
    from backend.routes.export import _EXPORT_DEFAULTS

    proj, lines, _ = wired
    seg = proj["data"]["segments"][0]
    seg["finalOutputId"] = "oA"
    expected = "song_" + song_render._export_hash("proj1", [seg], lines, {**_EXPORT_DEFAULTS})
    assert expected in cache_gc.reachable_hashes()


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


def _age(p, seconds):
    """Push a file's mtime past the recency window, so only REACHABILITY protects it."""
    import os

    st = os.stat(p)
    os.utime(p, (st.st_atime, st.st_mtime - seconds))


def test_sweep_keeps_clips_when_a_segment_hash_raises(wired, monkeypatch):
    """A raising `output_hash` is "we can't tell what's reachable", not "nothing is".

    `_hashes_from` swallowed every exception per segment and carried on with an
    INCOMPLETE keep-set, so a bug in hashing silently made a live project's clips look
    like junk and the sweep deleted them — minutes of render each. Same principle the
    DB-outage and moved-directory guards above already encode.
    """
    _, _, tmp = wired
    live = tmp / "fluid" / f"{next(iter(cache_gc.reachable_hashes()))}.mp4"
    live.write_bytes(b"x")
    _age(live, cache_gc.KEEP_RECENT_SEC + 3600)

    def boom(*a, **k):
        raise RuntimeError("output_hash is broken")

    monkeypatch.setattr(cache_gc.graphmod, "output_hash", boom)
    monkeypatch.setattr(cache_gc, "_last_run", 0.0)

    assert cache_gc.sweep() == 0
    assert live.exists(), "a hashing failure deleted a clip the project still references"


def test_sweep_keeps_song_exports_when_the_export_hash_raises(wired, monkeypatch):
    """Same guarantee for the whole-song master, which costs minutes plus HD asset
    regeneration to rebuild."""
    proj, _, tmp = wired
    proj["data"]["segments"][0]["finalOutputId"] = "oA"
    stem = tmp / "fluid" / "song_0123456789abcdef.mp4"
    stem.write_bytes(b"x")
    _age(stem, cache_gc.KEEP_RECENT_SEC + 3600)

    from backend import song_render

    def boom(*a, **k):
        raise RuntimeError("_export_hash is broken")

    monkeypatch.setattr(song_render, "_export_hash", boom)
    monkeypatch.setattr(cache_gc, "_last_run", 0.0)

    assert cache_gc.sweep() == 0
    assert stem.exists(), "a hashing failure deleted a whole-song export"


def test_sweep_still_reaps_assets_when_a_hash_fails(wired, monkeypatch):
    """The incomplete keep-set is specifically the CLIP one — asset reachability is
    computed without hashing, so suspending the clip phase must not disable asset GC
    (otherwise one permanently-malformed project would stop the sweep forever)."""
    proj, _, tmp = wired
    junk = tmp / "assets" / "proj1" / "orphan.png"
    junk.parent.mkdir(parents=True, exist_ok=True)
    junk.write_bytes(b"x")
    _age(junk, cache_gc.KEEP_RECENT_SEC + 3600)

    def boom(*a, **k):
        raise RuntimeError("output_hash is broken")

    monkeypatch.setattr(cache_gc.graphmod, "output_hash", boom)
    monkeypatch.setattr(cache_gc, "_last_run", 0.0)

    cache_gc.sweep()
    assert not junk.exists(), "asset GC stopped working because clip hashing failed"


def test_sweep_refuses_when_the_data_dirs_move_under_it(monkeypatch, tmp_path):
    """The sweep must NEVER compute "what to keep" against one directory and then delete
    from another. It used to read ASSETS_DIR twice; a background thread outliving a test
    fixture's monkeypatch hit that window and wiped a real asset library — the keep-set
    resolved to temp paths, then the delete loop walked the real one and matched nothing.
    """
    from backend import cache_gc

    real = tmp_path / "real"
    (real / "job1").mkdir(parents=True)
    keeper = real / "job1" / "aaaa.mp4"
    keeper.write_bytes(b"x")
    monkeypatch.setattr(cache_gc, "ASSETS_DIR", real)
    monkeypatch.setattr(cache_gc.paths, "ANIM_DIR", tmp_path / "anim")
    (tmp_path / "anim").mkdir()

    proj = {"job_id": "job1", "data": {"assets": [{"url": "/assets/job1/aaaa.mp4"}]}}

    def move_the_dirs_mid_scan():
        # what the daemon thread effectively did: the dirs change between the scan and
        # the delete loop
        monkeypatch.setattr(cache_gc, "ASSETS_DIR", tmp_path / "elsewhere")
        return [proj]

    monkeypatch.setattr(cache_gc.db, "get_projects_full", move_the_dirs_mid_scan)
    monkeypatch.setattr(cache_gc, "_last_run", 0.0)

    assert cache_gc.sweep(keep_recent_sec=0, now=9e9) == 0
    assert keeper.exists(), "the sweep deleted a file after its directories moved"
