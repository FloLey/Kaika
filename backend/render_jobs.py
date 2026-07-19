"""In-process manager for streaming render jobs (progressive block renders).

Separate from `jobs.py` (song ingestion) so a long render never queues behind — or
blocks — a demucs/Whisper worker, and vice-versa. Each job runs `graph.render_stream`
on a small thread pool and publishes per-block progress the frontend polls. Starting
a render is cheap; the UI cancels the previous job on every edit, so an abandoned
render stops between blocks instead of wasting the whole clip. In-memory and
single-process: state resets on restart (fine for a local dev tool).
"""

from __future__ import annotations

import logging
import os
import threading
import time
import uuid

from .job_table import prune_jobs
from .config import MAX_JOB_RECORDS
from concurrent.futures import ThreadPoolExecutor

# Enough workers that the output-node streams AND the per-card fluid/combine sim
# previews can render together without starving each other (the sim is GPU/MPS-bound,
# so extra workers mostly overlap the CPU-side ffmpeg encodes). Renders never share the
# ingestion pool (deliberately single-worker to serialise demucs/GPU work). Tune with
# RENDER_WORKERS (lower it if a big graph thrashes; raise it for snappier previews).
_POOL = ThreadPoolExecutor(max_workers=int(os.environ.get("RENDER_WORKERS", "4")))
_LOCK = threading.Lock()
_JOBS: dict[str, dict] = {}
_MAX_JOBS = MAX_JOB_RECORDS  # prune finished jobs beyond this (most-recent kept)
_log = logging.getLogger("kaika.render")


def _prune_locked() -> None:
    """Bound the render-job table. See `job_table.prune_jobs`."""
    prune_jobs(_JOBS, _MAX_JOBS)


def start(run) -> str:
    """Submit `run(on_progress, should_cancel) -> url` to the pool; return a render_id
    to poll. `run` should call `on_progress(frames_done, total, preview_url)` per
    block and check `should_cancel()` between blocks (both are wired to this job).

    A job that does slow work OUTSIDE the frame loop (the HD segment export regenerates
    images/stylize, then muxes audio) can name the current step with the optional
    `phase=` kwarg, so the UI shows why it's sitting at 0% instead of looking hung."""
    rid = uuid.uuid4().hex[:16]
    cancel = threading.Event()
    with _LOCK:
        _JOBS[rid] = {
            "state": "running",
            "frames_done": 0,
            "total": 0,
            "preview_url": None,
            "url": None,
            "error": None,
            "phase": None,
            "cancel": cancel,
            "updated": time.time(),
        }
        _prune_locked()

    def _progress(done=None, total=None, preview_url=None, *, phase: str | None = None) -> None:
        # `on_progress(phase="audio")` announces a step WITHOUT touching the frame
        # counters or the preview url — otherwise naming a phase would rewind the bar.
        with _LOCK:
            j = _JOBS.get(rid)
            if not j:
                return
            j["updated"] = time.time()
            if phase is not None:
                j["phase"] = phase
            if done is not None:
                j.update(frames_done=done, total=total, preview_url=preview_url)

    def _run() -> None:
        # Render duration is the single most useful number when the editor feels slow
        # (a card's preview IS a segment render), so every job reports how long it
        # took, how many frames it produced, and how many were queued behind it.
        t0 = time.perf_counter()
        try:
            url = run(_progress, cancel.is_set)
            state = "cancelled" if cancel.is_set() else "done"
            with _LOCK:
                j = _JOBS.get(rid)
                if j:
                    j.update(state=state, url=url, updated=time.time())
                    frames = j.get("frames_done") or 0
                running = sum(1 for x in _JOBS.values() if x.get("state") == "running")
            _log.info(
                "render %s %s in %.1fs (%d frames, %d still running)",
                rid,
                state,
                time.perf_counter() - t0,
                frames,
                running,
            )
        except Exception as e:  # noqa: BLE001
            _log.error("render job %s failed", rid, exc_info=e)
            with _LOCK:
                j = _JOBS.get(rid)
                if j:
                    j.update(state="error", error=f"{type(e).__name__}: {e}", updated=time.time())

    _POOL.submit(_run)
    return rid


def cancel(render_id: str) -> bool:
    """Signal the job to stop after its current block; True if the id was known."""
    with _LOCK:
        j = _JOBS.get(render_id)
        if not j:
            return False
        j["cancel"].set()
        return True


def get(render_id: str) -> dict | None:
    """Poll a job's public state (the cancel Event is internal, never serialised)."""
    with _LOCK:
        j = _JOBS.get(render_id)
        if not j:
            return None
        return {
            k: j[k]
            for k in ("state", "frames_done", "total", "preview_url", "url", "error", "phase")
        }
