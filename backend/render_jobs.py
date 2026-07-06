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
from concurrent.futures import ThreadPoolExecutor

# Enough workers that the output-node streams AND the per-card fluid/combine sim
# previews can render together without starving each other (the sim is GPU/MPS-bound,
# so extra workers mostly overlap the CPU-side ffmpeg encodes). Renders never share the
# ingestion pool (deliberately single-worker to serialise demucs/GPU work). Tune with
# RENDER_WORKERS (lower it if a big graph thrashes; raise it for snappier previews).
_POOL = ThreadPoolExecutor(max_workers=int(os.environ.get("RENDER_WORKERS", "4")))
_LOCK = threading.Lock()
_JOBS: dict[str, dict] = {}
_MAX_JOBS = 64  # prune finished jobs beyond this (most-recently-updated kept)
_log = logging.getLogger("kaika.render")


def _prune_locked() -> None:
    if len(_JOBS) <= _MAX_JOBS:
        return
    finished = sorted(
        ((rid, j) for rid, j in _JOBS.items() if j["state"] != "running"),
        key=lambda kv: kv[1]["updated"],
    )
    for rid, _ in finished[: len(_JOBS) - _MAX_JOBS]:
        _JOBS.pop(rid, None)


def start(run) -> str:
    """Submit `run(on_progress, should_cancel) -> url` to the pool; return a render_id
    to poll. `run` should call `on_progress(frames_done, total, preview_url)` per
    block and check `should_cancel()` between blocks (both are wired to this job)."""
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
            "cancel": cancel,
            "updated": time.time(),
        }
        _prune_locked()

    def _progress(done: int, total: int, preview_url: str | None) -> None:
        with _LOCK:
            j = _JOBS.get(rid)
            if j:
                j.update(frames_done=done, total=total, preview_url=preview_url, updated=time.time())

    def _run() -> None:
        try:
            url = run(_progress, cancel.is_set)
            state = "cancelled" if cancel.is_set() else "done"
            with _LOCK:
                j = _JOBS.get(rid)
                if j:
                    j.update(state=state, url=url, updated=time.time())
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
        return {k: j[k] for k in ("state", "frames_done", "total", "preview_url", "url", "error")}
