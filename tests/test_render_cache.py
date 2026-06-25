"""Tests for the render-clip cache eviction (B6.3)."""
import os
from pathlib import Path

from backend import render_cache


def _mk(d: Path, name: str, *, age_s: float, now: float, size: int = 10) -> Path:
    p = d / f"{name}.mp4"
    p.write_bytes(b"x" * size)
    os.utime(p, (now - age_s, now - age_s))   # backdate mtime/atime
    return p


def test_evict_ages_out_old_clips(tmp_path):
    now = 1_000_000.0
    fresh = _mk(tmp_path, "fresh", age_s=0, now=now)
    old = _mk(tmp_path, "old", age_s=40 * 86400, now=now)
    removed = render_cache.evict(tmp_path, max_bytes=10 ** 9, max_age_days=30, now=now)
    assert removed == 1
    assert fresh.exists() and not old.exists()


def test_evict_lru_until_under_cap(tmp_path):
    now = 1_000_000.0
    a = _mk(tmp_path, "a", age_s=300, size=100, now=now)   # least recently used
    b = _mk(tmp_path, "b", age_s=200, size=100, now=now)
    c = _mk(tmp_path, "c", age_s=100, size=100, now=now)   # most recent
    # Cap 250 with three 100-byte clips -> evict only the oldest.
    removed = render_cache.evict(tmp_path, max_bytes=250, max_age_days=3650, now=now)
    assert removed == 1
    assert not a.exists() and b.exists() and c.exists()


def test_touch_keeps_a_clip_hot(tmp_path):
    now = 1_000_000.0
    p = _mk(tmp_path, "p", age_s=40 * 86400, now=now)   # would age out...
    render_cache.touch(p)                                # ...but a hit refreshes it
    removed = render_cache.evict(tmp_path, max_bytes=10 ** 9, max_age_days=30)
    assert removed == 0 and p.exists()


def test_clear_removes_all(tmp_path):
    for n in "abc":
        (tmp_path / f"{n}.mp4").write_bytes(b"x")
    assert render_cache.clear(tmp_path) == 3
    assert not list(tmp_path.glob("*.mp4"))
