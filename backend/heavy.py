"""One GPU, one heavy job — admission for work that must never overlap.

Two kinds of work here are minutes-to-hours of MPS time: an **HD render** (whole-song
or one segment, including its diffusion asset passes) and a **card generation** (the
✨ on Image-gen / AI Stylize / Dream). Nothing stopped them running together, and the
result was not a queue but a slowdown: `imagegen._infer_lock` serialises the actual
inference, so two Dream loops interleave frame by frame and BOTH take twice as long.
Measured on this machine: a Z-Image Dream pass alone runs ~80 s/frame; with an HD
export's Dream pass beside it, both sat at ~83 s/frame each — i.e. half throughput,
for two jobs the user could only watch.

So admission is refused AT THE REQUEST rather than queued. A queued job would sit on a
worker holding its inputs for hours with nothing to show; a refusal is immediate, names
what is already running, and leaves the user to choose. This is the same call
`routes/export` already made for two concurrent HD renders — this module generalises
that single-slot rule across both kinds instead of leaving each side to guess about the
other.

Deliberately NOT covered: the ingestion pool (demucs/Whisper). It is GPU-heavy too, but
it runs once per song at upload time and never concurrently with studio work, so gating
it would only ever refuse something legitimate.
"""

from __future__ import annotations

import logging
import threading

log = logging.getLogger("kaika")

# Human labels for the two kinds — they end up in the 409 the user reads, so they are
# phrased as what is happening, not as an internal name.
HD_RENDER = "an HD render"
GENERATE = "a card generation"

_LOCK = threading.Lock()
_HOLDER: tuple[str, str] | None = None  # (kind, id) or None


def claim(kind: str, ident: str) -> tuple[str, str] | None:
    """Take the GPU for `(kind, ident)`.

    Returns `None` on success, or the CURRENT holder `(kind, id)` on refusal — the
    caller turns that into a 409 the user can act on. Never blocks.
    """
    global _HOLDER
    with _LOCK:
        if _HOLDER is not None:
            return _HOLDER
        _HOLDER = (kind, ident)
        log.info("heavy: %s (%s) took the GPU", kind, ident)
        return None


def adopt(old: str, new: str) -> None:
    """Re-key the live claim from `old` to `new`.

    For the one caller whose real id does not exist until AFTER it has been admitted: an
    HD render must hold the slot before `render_jobs.start` runs (or two requests both
    start a job), but the render_id it wants to publish comes out of that call. The slot
    is held across the swap, so nothing can slip in between; the only observable gap is
    that `holder()` briefly reports a placeholder id.
    """
    global _HOLDER
    with _LOCK:
        if _HOLDER is not None and _HOLDER[1] == old:
            _HOLDER = (_HOLDER[0], new)


def release(ident: str) -> None:
    """Hand the GPU back, if `ident` is what holds it.

    Checking the id is what makes this safe to call from a `finally` that may run after
    someone else already claimed: a blind release would hand away a slot this job never
    held, and the next two heavy jobs would run together — the exact failure this module
    exists to prevent, reintroduced by its own cleanup path.
    """
    global _HOLDER
    with _LOCK:
        if _HOLDER is not None and _HOLDER[1] == ident:
            _HOLDER = None


def holder() -> tuple[str, str] | None:
    """`(kind, id)` of whatever holds the GPU, or None."""
    with _LOCK:
        return _HOLDER


def refusal(current: tuple[str, str]) -> tuple[dict, int]:
    """The 409 body for a refused claim: what is running, and its id so the UI can poll
    or cancel it rather than just telling the user to try again."""
    kind, ident = current
    return {"error": f"{kind} is already running", "running": {"kind": kind, "id": ident}}, 409
