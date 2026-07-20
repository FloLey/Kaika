"""Disk cache of raw fluid frames — skip re-simulating when only downstream params
(color / grade / FX / background / combine opacity) change.

A fluid node's dye-on-transparent frames are fully determined by its `simulate()`
params dict, so `fluid.params_hash(params)` is a perfect key: an edit that doesn't
touch the fluid physics leaves that dict — and thus the key — unchanged, so the
expensive, stateful sim is reused while only the cheap per-frame downstream ops
re-run. Frames are grid-resolution (~50–100 MB for a minute), stored as `.npy` and
bounded (LRU + age) like the encoded-clip cache in `render_cache.py`.
"""

from __future__ import annotations

import logging
import os
import time
import uuid
from pathlib import Path

import numpy as np

from . import render_cache

log = logging.getLogger("kaika.cache")

CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "fluid_cache"
# Raw frames are bulkier than the encoded clips, so a larger byte cap. All overridable.
CACHE_MAX_BYTES = int(os.environ.get("FLUID_FRAME_CACHE_MAX_BYTES", str(8 * 1024**3)))  # 8 GB
CACHE_MAX_AGE_DAYS = float(os.environ.get("FLUID_FRAME_CACHE_MAX_AGE_DAYS", "14"))
# Largest single entry worth writing, as a share of the budget. Above this an entry
# cannot coexist with its siblings, so caching it only costs I/O (see `frame_writer`).
MAX_ENTRY_FRACTION = float(os.environ.get("FLUID_FRAME_CACHE_MAX_ENTRY_FRACTION", "0.25"))
ENABLED = os.environ.get("FLUID_FRAME_CACHE", "1") != "0"


def _path(key: str) -> Path:
    return CACHE_DIR / f"{key}.npy"


def load(key: str) -> np.ndarray | None:
    """Cached frames for `key`, memory-mapped read-only for cheap block slicing, or
    None on a miss. A hit refreshes the file mtime so it stays hot (LRU)."""
    if not ENABLED:
        return None
    p = _path(key)
    if not p.exists():
        return None
    try:
        arr = np.load(p, mmap_mode="r")
    except (OSError, ValueError):  # truncated / corrupt -> treat as a miss
        return None
    try:
        os.utime(p, None)  # touch: keep this hot entry from aging out
    except OSError:
        pass
    return arr


def store(key: str, frames: np.ndarray) -> None:
    """Cache `frames` under `key`. Atomic (write-tmp-then-rename) and best-effort — a
    failure just means a future miss. Bounds the cache afterward."""
    if not ENABLED:
        return
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    p = _path(key)
    # pid + uuid: two THREADS resolving the same params key concurrently (a stack
    # combine's branch pools, two streams of one graph) must not share a temp file —
    # same collision class the render scratch dirs were uuid'd for.
    tmp = p.with_name(f"{key}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        # Write through a file handle so numpy keeps our name (a path arg would have
        # `.npy` appended); the on-disk format is standard .npy regardless of suffix.
        with open(tmp, "wb") as fh:
            np.save(fh, np.ascontiguousarray(frames))
        os.replace(tmp, p)  # atomic on the same filesystem
    except OSError as e:
        log.warning("fluid frame cache: store failed (%s)", e)
        try:
            tmp.unlink()
        except OSError:
            pass
        return
    evict()


def frame_writer(key: str, shape: tuple):
    """Incremental cache writer -> (memmap, finalize, discard). Lets a streaming render
    fill the cache block-by-block (`mm[a:b] = block`) without holding the whole clip in
    RAM; `finalize()` flushes, atomically renames into place, and evicts. `discard()`
    drops the partial temp file if the render is abandoned before finalize (a no-op
    once finalized). Returns `(None, noop, noop)` when disabled or unopenable — the
    render still runs, just uncached. (`evict()` also reaps any temp left behind.)"""
    noop = lambda: None  # noqa: E731
    if not ENABLED:
        return None, noop, noop
    # An entry bigger than a fraction of the whole budget can only be written and then
    # evicted before anything reads it — LRU has no room to keep it AND the entries the
    # same render is about to write. That is exactly what a 4K montage does: 32 MB per
    # RGBA frame is 2.2 GB for a 3-second slot against an 8 GB cap, so 23 slots evict
    # each other in turn and the write is pure loss. Refuse it: the render just runs
    # uncached, which is what was happening anyway, minus the I/O.
    want = int(np.prod(shape))
    if want > CACHE_MAX_BYTES * MAX_ENTRY_FRACTION:
        log.info(
            "fluid frame cache: skipping a %.1f GB entry (over %.0f%% of the %.0f GB budget)",
            want / 1024**3,
            MAX_ENTRY_FRACTION * 100,
            CACHE_MAX_BYTES / 1024**3,
        )
        return None, noop, noop
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CACHE_DIR / f"{key}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp.npy"
    try:
        mm = np.lib.format.open_memmap(tmp, mode="w+", dtype=np.uint8, shape=shape)
    except (OSError, ValueError) as e:
        log.warning("fluid frame cache: writer open failed (%s)", e)
        return None, noop, noop
    done = {"v": False}

    def finalize() -> None:
        try:
            mm.flush()
            os.replace(tmp, _path(key))  # atomic on the same filesystem
        except OSError as e:
            log.warning("fluid frame cache: finalize failed (%s)", e)
            try:
                tmp.unlink()
            except OSError:
                pass
            return
        done["v"] = True
        evict()

    def discard() -> None:
        if done["v"]:
            return
        try:
            tmp.unlink()
        except OSError:
            pass

    return mm, finalize, discard


def _rm(p: Path) -> bool:
    try:
        p.unlink()
        return True
    except OSError:
        return False


def evict(
    *,
    max_bytes: int = CACHE_MAX_BYTES,
    max_age_days: float = CACHE_MAX_AGE_DAYS,
    now: float | None = None,
) -> int:
    """Age-out then LRU-evict the frame cache; return the count removed. `now` is
    injectable for tests. Shares `render_cache`'s policy (mtime = last use)."""
    now = time.time() if now is None else now
    # Reap abandoned incremental writes (a render cancelled before finalize). Their
    # mtime advances every block while active, so anything untouched for >5 min is dead.
    for p in CACHE_DIR.glob("*.tmp.npy"):
        try:
            if now - p.stat().st_mtime > 300:
                p.unlink()
        except OSError:
            pass

    committed = (p for p in CACHE_DIR.glob("*.npy") if not p.name.endswith(".tmp.npy"))
    removed = render_cache.evict_entries(
        render_cache.stat_entries(committed),
        max_bytes=max_bytes,
        max_age_days=max_age_days,
        now=now,
    )
    if removed:
        log.info("fluid frame cache: evicted %d entr(ies)", removed)
    return removed


def clear() -> int:
    """Remove every cached frame array (the `make clean-cache` path)."""
    if not CACHE_DIR.exists():
        return 0
    return sum(1 for p in CACHE_DIR.glob("*.npy") if _rm(p))
