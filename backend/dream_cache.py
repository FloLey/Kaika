"""Per-FRAME cache for the Dream card's generated images (specs/dream/02).

AI Stylize caches its whole clip as one content-addressed asset, which is right for it:
its inputs are a prompt and a strength, and changing either changes every frame. Dream's
input is a *schedule*, and the gesture the card exists for — dragging a cut around —
changes a handful of frames out of hundreds. At one diffusion call per frame, whole-clip
regeneration would make the timeline editor unusable, so the cache is not an optimisation
here; it is what makes the card's core interaction viable.

The key canonicalizes hold frames (see `canonical_prompts`), which is the property the
whole design rests on: a cut nudge changes the blend weights of that transition's ramp
frames only, so every hold frame in both neighbouring parts survives untouched.

Frames are PNG, not `.npy`: lossless — so a cache hit is byte-identical to a miss, which
is what makes the parity test meaningful — at roughly a third of the raw size.
"""

from __future__ import annotations

import hashlib
import logging
import os
import time
import uuid
from pathlib import Path

import numpy as np

from . import paths, render_cache

log = logging.getLogger("kaika.cache")

# Sized like the fluid frame cache: draft frames at 384² are small, but an HD export
# generates a whole song at 768². All overridable.
CACHE_MAX_BYTES = int(os.environ.get("DREAM_FRAME_CACHE_MAX_BYTES", str(8 * 1024**3)))  # 8 GB
CACHE_MAX_AGE_DAYS = float(os.environ.get("DREAM_FRAME_CACHE_MAX_AGE_DAYS", "14"))
ENABLED = os.environ.get("DREAM_FRAME_CACHE", "1") != "0"

# BUMP THIS whenever `imagegen.dream_frames` changes what it draws for the same inputs.
# The key is content-addressed on the card's inputs, which cannot see a change in the
# CODE — so without this a pipeline change silently keeps serving pictures made by the
# old one, and the card looks broken ("I changed things and it regenerated the same").
# This is the same exposure `fluid_cache` has; there the answer is "clear the cache by
# hand", which is not good enough for a card whose whole loop is regenerate-and-look.
#   1: initial (pure txt2img + control)
#   2: the optional `video` input — `_seeded_start`'s control-weighted pixel scatter
#   3: that scatter moved to LATENT space (`_keep_mask` + per-step re-injection).
#      v2 emitted pure noise for every video-wired frame; without this bump they
#      would keep being served.
CACHE_VERSION = 3


def _dir() -> Path:
    """Read late-bound so tests patch `backend.paths` once (the hard invariant) rather
    than a per-module constant."""
    return paths.DREAM_CACHE_DIR


def _path(key: str) -> Path:
    return _dir() / f"{key}.png"


def canonical_prompts(step: dict) -> tuple[str, str, float]:
    """The prompt state of one plan entry, canonicalized for keying: (a, b, w).

    At w == 0 the second prompt is IRRELEVANT to the generated pixels, and at w == 1 the
    first one is — so both collapse to a single-prompt state with w = 0. That collapse is
    what makes the cache worth building: without it, every hold frame would key against
    its neighbouring part's prompt, and nudging one cut would invalidate two whole parts
    instead of one transition's ramp.

    `w` is rounded to 3 decimals so float noise from a re-resolved curve cannot bust a key.
    """
    w = float(step.get("w") or 0.0)
    a = str(step.get("prompt_a") or "")
    b = step.get("prompt_b")
    if w <= 0 or not b:
        return a, "", 0.0
    if w >= 1:
        return str(b), "", 0.0
    return a, str(b), round(w, 3)


def frame_key(
    control_img: np.ndarray,
    step: dict,
    model: str,
    height: int,
    width: int,
    init_img: np.ndarray | None = None,
) -> str:
    """Cache key for one generated frame.

    `control_img` is the RESIZED control image — the exact array that reaches the pipe,
    hashed by content. Hashing it (rather than keying on the upstream node's hash) is what
    makes an upstream edit cheap: a change that happens to leave a given frame's control
    untouched keeps that frame cached, and a still control dedupes across time for free.

    `init_img` is the optional per-frame START image (the card's wired `video` input). It
    changes every pixel of the result, so it is hashed too — and `keep` with it, but ONLY
    when there is an init: without one the pipe never sees it, so folding it in would
    split the cache on a value that changed nothing.

    There is no negative prompt in the key because there is none in the call — CFG is off
    at guidance_scale 0, so a negative prompt is inert (see imagegen.dream_frames).
    """
    a, b, w = canonical_prompts(step)
    h = hashlib.sha1(usedforsecurity=False)
    h.update(np.ascontiguousarray(control_img).tobytes())
    parts = [
        f"v{CACHE_VERSION}",
        a,
        b,
        f"{w:.3f}",
        str(int(step["seed"])),
        str(model),
        str(int(height)),
        str(int(width)),
        f"{float(step.get('scale', 0.7)):.3f}",
    ]
    if init_img is not None:
        h.update(np.ascontiguousarray(init_img).tobytes())
        parts.append(f"k{float(step.get('keep', 0.1)):.3f}")
    h.update("|".join(parts).encode())
    return h.hexdigest()[:32]


def load(key: str) -> np.ndarray | None:
    """The cached RGB frame for `key`, or None on a miss. A hit touches the file so it
    stays hot (mtime = last use, the render_cache policy)."""
    if not ENABLED:
        return None
    p = _path(key)
    if not p.exists():
        return None
    try:
        import cv2

        bgr = cv2.imread(str(p), cv2.IMREAD_COLOR)
    except Exception:  # noqa: BLE001 — a corrupt entry is just a miss
        return None
    if bgr is None:
        return None
    try:
        os.utime(p, None)
    except OSError:
        pass
    return bgr[..., ::-1].copy()  # BGR -> RGB


def store(key: str, frame: np.ndarray) -> None:
    """Cache one RGB frame. Atomic (write-tmp-then-rename) and best-effort — a failure
    just means a future miss.

    Note this does NOT evict, unlike `fluid_cache.store`. That one is called once per
    clip; this one is called once per FRAME, and globbing the whole directory hundreds of
    times inside a single job would cost more than it saves. The caller evicts once when
    the job finishes (`imagegen.dream_frames`), which is safe because a single job's
    output is orders of magnitude below the budget."""
    if not ENABLED:
        return
    d = _dir()
    d.mkdir(parents=True, exist_ok=True)
    p = _path(key)
    # pid + uuid: two threads generating the same frame concurrently must not share a
    # temp file — the collision class fluid_cache's writes are uuid'd for.
    tmp = p.with_name(f"{key}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp.png")
    try:
        import cv2

        cv2.imwrite(str(tmp), np.ascontiguousarray(frame)[..., ::-1])  # RGB -> BGR
        os.replace(tmp, p)  # atomic on the same filesystem
    except Exception as e:  # noqa: BLE001 — never fail a generation over the cache
        log.warning("dream frame cache: store failed (%s)", e)
        try:
            tmp.unlink()
        except OSError:
            pass


def evict(
    *,
    max_bytes: int = CACHE_MAX_BYTES,
    max_age_days: float = CACHE_MAX_AGE_DAYS,
    now: float | None = None,
) -> int:
    """Age-out then LRU-evict; return the count removed. `now` is injectable for tests.
    Shares `render_cache`'s policy with the clip and fluid-frame caches."""
    d = _dir()
    if not d.exists():
        return 0
    now = time.time() if now is None else now
    for p in d.glob("*.tmp.png"):  # abandoned writes (a job killed mid-store)
        try:
            if now - p.stat().st_mtime > 300:
                p.unlink()
        except OSError:
            pass
    committed = (p for p in d.glob("*.png") if not p.name.endswith(".tmp.png"))
    removed = render_cache.evict_entries(
        render_cache.stat_entries(committed),
        max_bytes=max_bytes,
        max_age_days=max_age_days,
        now=now,
    )
    if removed:
        log.info("dream frame cache: evicted %d entr(ies)", removed)
    return removed


def clear() -> int:
    """Remove every cached frame (the `make clean-cache` path)."""
    d = _dir()
    if not d.exists():
        return 0
    n = 0
    for p in d.glob("*.png"):
        try:
            p.unlink()
            n += 1
        except OSError:
            pass
    return n
