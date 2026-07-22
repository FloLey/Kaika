"""Reachability GC for the render-clip cache (`data/fluid/*.mp4`).

Live slider-editing renders a new mp4 for every distinct graph state and the old
policy (`render_cache`) only aged them out over 30 days, so the cache fills with
stale intermediates (a real cache was ~92% junk). This sweep keeps only the clips a
saved project's CURRENT state points to — plus anything rendered in the last
`KEEP_RECENT_SEC` (the clips of the session you're editing right now) — and deletes
the rest. Safe to over-delete: since the fluid-frame cache + block streaming make a
re-render cheap, a wrongly-evicted clip just rebuilds fast.

Runs automatically after a project save and once on startup; `python -m
backend.cache_gc` (make gc-cache) runs it by hand.
"""

from __future__ import annotations

import json
import logging
import re
import os
import time

from . import db
from . import graph as graphmod
from . import paths
from .compositions import final_output_id, root_composition
from .paths import ANALYSIS_DIR, ASSETS_DIR, asset_file_for_url

log = logging.getLogger("kaika.cache")

# In-flight clips of the current editing session are always freshly `touch`ed (every
# render refreshes mtime), so a generous idle window keeps them even across a pause.
KEEP_RECENT_SEC = int(os.environ.get("FLUID_CACHE_KEEP_RECENT_SEC", "1800"))  # 30 min

_last_run = 0.0  # module-level throttle so rapid saves don't re-sweep every time


def _lyric_lines(job_id: str) -> list:
    """A project's aligned lyric lines (from the analysis cache) — the same source
    `projects.project_get` feeds the frontend, so the hash folds in identical text."""
    p = ANALYSIS_DIR / f"{job_id}.json"
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text()).get("lyric_lines", []) or []
    except (OSError, ValueError):
        return []


def _hashes_from(row: dict, job_id: str) -> tuple[set[str], bool]:
    """`(render-cache keys the row's CURRENT state maps to, keys_are_complete)`.

    One key per (segment × output node), plus the whole-song `song_<hash>` export stems.

    The second element is the important one. A hashing failure used to be swallowed per
    segment and the sweep carried on with an INCOMPLETE keep-set — which reads exactly
    like "these clips are junk" and deletes minutes of rendered work. The module already
    refuses to confuse "can't tell what's reachable" with "nothing is reachable" for a DB
    outage (`_reachable`) and for a moved data directory (`sweep`); this is the same rule
    at segment granularity. We still skip the bad segment and keep scanning — a partial
    keep-set is useful for the ASSET half — but we report that the clip keep-set can't be
    trusted, and `sweep` then declines to delete any clip.
    """
    data = row.get("data") or {}
    output = data.get("output") or {}
    pool = data.get("compositions") or {}
    lines = _lyric_lines(job_id)
    keys: set[str] = set()
    complete = True
    for seg in data.get("segments") or []:
        graph = (root_composition(pool, seg) or {}).get("graph")
        if not graph:
            continue
        seg_h = {**seg, "lyric_lines": seg.get("lyric_lines") or lines}
        try:
            outputs = [n["id"] for n in graph.get("nodes", []) if n.get("type") == "output"]
            for output_id in outputs:
                keys.add(graphmod.output_hash(job_id, seg_h, graph, output_id, output))
        except Exception as e:  # noqa: BLE001 — one bad graph must not sink the whole scan
            log.warning(
                "cache gc: could not hash a segment of %s (%s) — clip deletion suspended",
                job_id,
                e,
            )
            complete = False
    stems, stems_complete = _song_export_stems(row, job_id, lines)
    return keys | stems, complete and stems_complete


def _song_export_stems(row: dict, job_id: str, lines: list) -> tuple[set[str], bool]:
    """`(HD-export stems of this project, stems_are_complete)` — whole-song masters
    (`song_<hash>`) AND
    single-segment HD renders (`<hash>` + its muxed `hd-…` sibling). These took
    minutes (plus HD asset regeneration) and must never be reaped as junk. Two
    sources, both kept:

    - the stems RECORDED at export time (routes/export._record_export) — always
      exact, and for a segment render the ONLY possible source: the HD regen swaps
      assetUrls in memory only, and the graph rendered may never have been saved;
    - a best-effort RECOMPUTE of the whole-song hash from the saved state (exact
      whenever no imagegen card was regenerated), which covers exports finished
      before the recording existed.
    """
    from . import song_render  # lazy: keeps `python -m backend.cache_gc` startup light

    stems: set[str] = set()
    complete = True
    p = ANALYSIS_DIR / f"{job_id}.json"
    if p.exists():
        try:
            analysis = json.loads(p.read_text())
            for key in ("song_exports", "segment_exports"):
                stems |= {str(s) for s in analysis.get(key, []) or []}
        except (OSError, ValueError) as e:
            # The RECORDED stems are the only source for a segment HD render, so losing
            # them to a corrupt analysis file means we genuinely cannot tell what is
            # reachable — don't let the sweep delete on that basis.
            log.warning("cache gc: unreadable analysis cache for %s (%s)", job_id, e)
            complete = False
    data = row.get("data") or {}
    segments = data.get("segments") or []
    pool = data.get("compositions") or {}
    if segments and all(final_output_id(root_composition(pool, s)) for s in segments):
        export = {**song_render.EXPORT_DEFAULTS, **(data.get("export") or {})}
        try:
            stems.add("song_" + song_render._export_hash(job_id, segments, pool, lines, export))
        except Exception as e:  # noqa: BLE001 — a bad segment must not sink the whole scan
            log.warning(
                "cache gc: couldn't hash %s's song export (%s) — clip deletion suspended",
                job_id,
                e,
            )
            complete = False
    return stems, complete


def _asset_file(url: str, root=None):
    """`/assets/<job>/<name>` -> its on-disk path, or None. `root` defaults to the module
    ASSETS_DIR; `sweep` passes an explicit snapshot so the keep-set and the directory it
    later walks are guaranteed to be the same one (see the safety check in `sweep`)."""
    return asset_file_for_url(url, ASSETS_DIR if root is None else root)


def _assets_from(row: dict, root=None) -> set:
    """The asset files a project keeps alive: every entry in its `data.assets` LIBRARY
    plus any node carrying an `assetUrl` (image/video/backdrop). So a library asset stays
    even before a card uses it, and a card's asset stays even if not (yet) in the library.

    Walks EVERY composition in the pool, referenced or not — an orphaned composition
    keeps its assets alive until the pool prune (step 07) removes it, deliberately:
    asset loss is the harm worth being conservative about."""
    data = row.get("data") or {}
    files: set = set()
    for a in data.get("assets") or []:
        f = _asset_file(a.get("url"), root)
        if f:
            files.add(f)
    for comp in (data.get("compositions") or {}).values():
        for n in ((comp or {}).get("graph") or {}).get("nodes") or []:
            d = n.get("data") or {}
            f = _asset_file(d.get("assetUrl"), root)
            if f:
                files.add(f)
            # The imagegen card carries a LIST of generated image urls (assetUrls).
            for url in d.get("assetUrls") or []:
                f = _asset_file(url, root)
                if f:
                    files.add(f)
            # The slideshow card's own picks live in `items: [{url, kind, start}]`
            # (v23) — keep each item's file alive too, else a slideshow video/image gets
            # swept while still referenced. (Legacy assetUrls handled by the loop above.)
            for it in d.get("items") or []:
                f = _asset_file((it or {}).get("url"), root) if isinstance(it, dict) else None
                if f:
                    files.add(f)
    return files


def _reachable(assets_root=None) -> tuple[set[str], set, bool]:
    """(reachable clip hashes, reachable asset files, clip hashes are complete) across ALL
    saved projects (the Playground row included), in a SINGLE query — one connection
    instead of one per project.

    Raises `db.DBUnavailable` if the project list can't be read — callers MUST treat
    that as "unknown" and NOT delete anything (empty sets would nuke the caches).

    The third element is the same guarantee at a finer grain: False means at least one
    project's clip keys could not be computed, so the hash set is a SUBSET of what is
    really reachable and must not be used to decide deletions. Asset reachability is
    computed without hashing, so it stays trustworthy either way."""
    hashes: set[str] = set()
    assets: set = set()
    complete = True
    for row in db.get_projects_full():
        row_hashes, row_complete = _hashes_from(row, row["job_id"])
        hashes |= row_hashes
        complete = complete and row_complete
        assets |= _assets_from(row, assets_root)
    return hashes, assets, complete


def reachable_hashes() -> set[str]:
    """The cache keys reachable from all saved projects' current state (+ Playground).

    Best-effort: if a project's hashing fails this is a subset. Use `_reachable`'s third
    element before deleting anything on the strength of it."""
    return _reachable()[0]


def reachable_assets() -> set:
    """Every asset file referenced by any saved project (+ Playground)."""
    return _reachable()[1]


def sweep(*, keep_recent_sec: int = KEEP_RECENT_SEC, now: float | None = None) -> int:
    """Delete cached clips that no saved project references and that weren't rendered
    in the last `keep_recent_sec`. Returns the count removed (0 if it bailed).

    Bails without deleting anything if the DB is unavailable — we must never confuse
    "can't tell what's reachable" with "nothing is reachable"."""
    global _last_run
    now = time.time() if now is None else now
    if now - _last_run < 5.0:  # a burst of saves shouldn't re-sweep repeatedly
        return 0
    _last_run = now
    # Snapshot the two directories ONCE. They are module/`paths` globals, and this used to
    # read them twice: the keep-set was resolved against whatever ASSETS_DIR held at that
    # instant, then the delete loop walked whatever it held a moment later. A test fixture
    # (or any code) that re-pointed them in between turned "nothing here is reachable" into
    # a full wipe of the real library — which is exactly what happened once. Same snapshot
    # for both halves, and a re-read check before deleting anything.
    anim_dir, assets_dir = paths.ANIM_DIR, ASSETS_DIR
    try:
        reachable, keep_assets, clips_known = _reachable(assets_dir)
    except db.DBUnavailable as e:
        log.warning("cache gc: DB unavailable, skipping sweep (%s)", e)
        return 0
    if (paths.ANIM_DIR, ASSETS_DIR) != (anim_dir, assets_dir):
        log.warning("cache gc: data dirs changed while scanning — skipping sweep")
        return 0

    removed = 0
    cutoff = now - keep_recent_sec
    # An incomplete keep-set means we know some clips are reachable but not WHICH, so
    # every unmatched clip is a maybe, not junk. Skip the clip phase entirely and keep
    # sweeping assets, whose reachability never went through a hash — otherwise one
    # permanently-malformed project would disable the GC forever instead of just the part
    # it actually undermines.
    if not clips_known:
        log.warning("cache gc: clip keep-set incomplete — not deleting any clip this sweep")
    else:
        for p in anim_dir.glob("*.mp4"):  # non-recursive: leaves stream/ scratch
            if p.stem in reachable:
                continue
            try:
                if p.stat().st_mtime > cutoff:  # a clip from the active session
                    continue
                p.unlink()
                removed += 1
            except OSError:
                continue

    # Reap image/video assets no saved project references (recency protects fresh
    # uploads for an unsaved edit), then drop any per-job dirs left empty. A video's
    # server-side companions (`<sha>-thumb.jpg` for the library grid, `<sha>-proxy.mp4`
    # for card previews — routes/uploads.py) are never referenced by a project itself:
    # they live and die with their base file.
    kept_stems = {(p.parent, p.stem) for p in keep_assets}
    for p in assets_dir.glob("*/*"):
        if p in keep_assets:
            continue
        # `<sha>-thumb.jpg` / `<sha>-proxy.mp4` / `<sha>-clip-<t>-<d>.mp4`: all keyed
        # off their base file's stem, none referenced by a project.
        base = re.split(r"-(?:thumb|proxy|clip)\b", p.name, maxsplit=1)[0]
        if base != p.name and (p.parent, base) in kept_stems:
            continue
        try:
            if p.stat().st_mtime > cutoff:
                continue
            p.unlink()
            removed += 1
        except OSError:
            continue
    for d in assets_dir.glob("*"):
        try:
            if d.is_dir() and not any(d.iterdir()):
                d.rmdir()
        except OSError:
            continue

    if removed:
        log.info("cache gc: removed %d stale item(s); kept %d clip(s)", removed, len(reachable))
    return removed


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    print(f"gc: removed {sweep()} stale clip(s)")
