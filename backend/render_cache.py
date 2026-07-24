"""LRU + age eviction for the rendered-clip cache (data/fluid/*.mp4).

The clips are a pure cache — every file is reproducible from its graph hash — so we
can bound the directory's growth (it reaches ~1 GB quickly). Policy: drop clips
unused for longer than an age cutoff, then evict least-recently-used until the
directory fits a size cap. "Recently used" is the file mtime, refreshed by `touch`
on every cache hit, so hot clips survive and stale ones age out.

Defaults are generous and overridable via env (FLUID_CACHE_MAX_BYTES / _MAX_AGE_DAYS).
`evict` is called opportunistically after each render; `make clean-cache` clears all.
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path

log = logging.getLogger("kaika.cache")

# Backstop only: the reachability sweep (cache_gc.py) is the primary cleaner now, so
# these caps just bound a long UNSAVED editing session between sweeps. NOT modest any
# more: the old 2 GB was sized for card previews and could not even hold ONE 4K
# export's working set (a ~1.5 GB master + ~2 GB of per-segment HD clips + trims) —
# the LRU crushed the segment clips the INCREMENTAL export exists to reuse, and every
# re-export silently paid a full re-render. The cap must fit the HD working set with
# room for previews; the age limit and the sweep still bound long-term growth.
CACHE_MAX_BYTES = int(os.environ.get("FLUID_CACHE_MAX_BYTES", str(16 * 1024**3)))  # 16 GB
CACHE_MAX_AGE_DAYS = float(os.environ.get("FLUID_CACHE_MAX_AGE_DAYS", "14"))


def touch(path: Path) -> None:
    """Mark a clip as just-used (refresh its mtime) so a cache hit keeps it hot."""
    try:
        os.utime(path, None)
    except OSError:
        pass


def _rm(p: Path) -> bool:
    try:
        p.unlink()
        return True
    except OSError:
        return False


def stat_entries(paths) -> list[tuple[Path, float, int]]:
    """`[(path, mtime, size)]` for the given paths, skipping unstat-able ones."""
    entries: list[tuple[Path, float, int]] = []
    for p in paths:
        try:
            st = p.stat()
        except OSError:
            continue
        entries.append((p, st.st_mtime, st.st_size))
    return entries


def evict_entries(
    entries: list[tuple[Path, float, int]], *, max_bytes: int, max_age_days: float, now: float
) -> int:
    """The shared age-out + LRU policy over `[(path, mtime, size)]`; returns the count
    removed. Used by this clip cache and the raw-frame cache (fluid_cache)."""
    removed = 0
    # 1. Age-out: drop anything unused for longer than the cutoff.
    cutoff = now - max_age_days * 86400
    kept: list[tuple[Path, float, int]] = []
    for p, mtime, size in entries:
        if mtime < cutoff and _rm(p):
            removed += 1
        else:
            kept.append((p, mtime, size))

    # 2. Size cap: evict least-recently-used (oldest mtime) until under the cap.
    total = sum(size for _, _, size in kept)
    if total > max_bytes:
        for p, _mtime, size in sorted(kept, key=lambda t: t[1]):  # oldest first
            if total <= max_bytes:
                break
            if _rm(p):
                removed += 1
                total -= size
    return removed


def evict(
    cache_dir: Path,
    *,
    max_bytes: int = CACHE_MAX_BYTES,
    max_age_days: float = CACHE_MAX_AGE_DAYS,
    now: float | None = None,
) -> int:
    """Age-out then LRU-evict the clip cache; return the count removed.

    `now` is injectable for tests (defaults to time.time())."""
    now = time.time() if now is None else now
    removed = evict_entries(
        stat_entries(cache_dir.glob("*.mp4")),
        max_bytes=max_bytes,
        max_age_days=max_age_days,
        now=now,
    )
    if removed:
        log.info("render cache: evicted %d clip(s)", removed)
    return removed


def clear(cache_dir: Path) -> int:
    """Remove every cached clip (the `make clean-cache` path). Returns the count."""
    return sum(1 for p in cache_dir.glob("*.mp4") if _rm(p))
