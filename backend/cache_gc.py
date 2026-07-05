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
import os
import time

from . import db
from . import graph as graphmod
from .paths import ANALYSIS_DIR, ASSETS_DIR

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


def _hashes_from(row: dict, job_id: str) -> set[str]:
    """Every render-cache key the given project row's CURRENT state maps to — one per
    (segment × output node). A malformed segment/graph is skipped, not fatal."""
    data = row.get("data") or {}
    output = data.get("output") or {}
    lines = _lyric_lines(job_id)
    keys: set[str] = set()
    for seg in data.get("segments") or []:
        graph = seg.get("graph")
        if not graph:
            continue
        seg_h = {**seg, "lyric_lines": seg.get("lyric_lines") or lines}
        try:
            outputs = [n["id"] for n in graph.get("nodes", []) if n.get("type") == "output"]
            for output_id in outputs:
                keys.add(graphmod.output_hash(job_id, seg_h, graph, output_id, output))
        except Exception as e:  # noqa: BLE001 — one bad graph must not sink the sweep
            log.warning("cache gc: skipped a segment of %s (%s)", job_id, e)
    return keys


def _asset_file(url: str):
    """`/assets/<job>/<name>` -> its on-disk path, or None."""
    parts = (url or "").strip("/").split("/")
    return ASSETS_DIR / parts[1] / parts[2] if len(parts) == 3 and parts[0] == "assets" else None


def _assets_from(row: dict) -> set:
    """The asset files a project keeps alive: every entry in its `data.assets` LIBRARY
    plus any node carrying an `assetUrl` (image/video/backdrop). So a library asset stays
    even before a card uses it, and a card's asset stays even if not (yet) in the library."""
    data = row.get("data") or {}
    files: set = set()
    for a in data.get("assets") or []:
        f = _asset_file(a.get("url"))
        if f:
            files.add(f)
    for seg in data.get("segments") or []:
        for n in (seg.get("graph") or {}).get("nodes") or []:
            f = _asset_file((n.get("data") or {}).get("assetUrl"))
            if f:
                files.add(f)
    return files


def _reachable() -> tuple[set[str], set]:
    """(reachable clip hashes, reachable asset files) across ALL saved projects (the
    Playground row included), in a SINGLE query — one connection instead of one per
    project.

    Raises `db.DBUnavailable` if the project list can't be read — callers MUST treat
    that as "unknown" and NOT delete anything (empty sets would nuke the caches)."""
    hashes: set[str] = set()
    assets: set = set()
    for row in db.get_projects_full():
        hashes |= _hashes_from(row, row["job_id"])
        assets |= _assets_from(row)
    return hashes, assets


def reachable_hashes() -> set[str]:
    """The cache keys reachable from all saved projects' current state (+ Playground)."""
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
    try:
        reachable, keep_assets = _reachable()  # single DB pass for both clips + assets
    except db.DBUnavailable as e:
        log.warning("cache gc: DB unavailable, skipping sweep (%s)", e)
        return 0

    removed = 0
    cutoff = now - keep_recent_sec
    for p in graphmod.ANIM_DIR.glob("*.mp4"):  # non-recursive: leaves stream/ scratch
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
    # uploads for an unsaved edit), then drop any per-job dirs left empty.
    for p in ASSETS_DIR.glob("*/*"):
        if p in keep_assets:
            continue
        try:
            if p.stat().st_mtime > cutoff:
                continue
            p.unlink()
            removed += 1
        except OSError:
            continue
    for d in ASSETS_DIR.glob("*"):
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
