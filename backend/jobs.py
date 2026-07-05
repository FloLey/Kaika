"""Tiny in-process job manager.

Runs slow work (yt-dlp, demucs, Whisper) off the Flask request thread so
``/upload`` and ``/segment`` return a job id immediately and the UI polls
``/jobs/<id>`` for progress. In-memory and single-process — jobs reset if the
server restarts (fine for a local dev tool). A small thread pool runs the work;
the default of one worker keeps two demucs separations from fighting over the
GPU at once, and means matplotlib's pyplot state is only ever touched by one
(consistent) worker thread.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

_POOL = ThreadPoolExecutor(max_workers=int(os.environ.get("JOB_WORKERS", "1")))
_LOCK = threading.Lock()
_JOBS: dict[str, dict] = {}
_MAX_JOBS = 64  # prune finished jobs beyond this (most-recently-updated kept)
_log = logging.getLogger("kaika.jobs")


def _prune_locked() -> None:
    """Drop the oldest finished jobs once the map exceeds `_MAX_JOBS`, so a
    long-lived server doesn't grow one entry per upload forever (mirrors
    `render_jobs._prune_locked`)."""
    if len(_JOBS) <= _MAX_JOBS:
        return
    finished = sorted(
        ((jid, j) for jid, j in _JOBS.items() if j["state"] != "running"),
        key=lambda kv: kv[1]["updated"],
    )
    for jid, _ in finished[: len(_JOBS) - _MAX_JOBS]:
        _JOBS.pop(jid, None)


def submit(job_id: str, step: str, fn) -> None:
    """Register ``job_id`` as running and run ``fn()`` in the background.

    ``fn`` returns the result dict (stored and exposed when the job finishes);
    any exception it raises marks the job failed with the message.
    """
    with _LOCK:
        _JOBS[job_id] = {
            "state": "running", "step": step, "error": None, "result": None,
            "updated": time.time(),
        }
        _prune_locked()

    _log.info("job %s started (%s)", job_id, step)

    def _run():
        try:
            result = fn()
            with _LOCK:
                if job_id in _JOBS:
                    _JOBS[job_id].update(
                        state="done", step="done", result=result, updated=time.time()
                    )
            _log.info("job %s done", job_id)
        except Exception as e:  # noqa: BLE001
            # Full traceback to the log stream; the job's `error` string stays
            # exactly as-is for the existing pollJob UI.
            _log.error("job %s failed", job_id, exc_info=e)
            with _LOCK:
                if job_id in _JOBS:
                    _JOBS[job_id].update(
                        state="error", error=f"{type(e).__name__}: {e}", updated=time.time()
                    )

    _POOL.submit(_run)


def set_step(job_id: str, step: str) -> None:
    with _LOCK:
        if job_id in _JOBS:
            _JOBS[job_id].update(step=step, updated=time.time())
    _log.info("job %s → %s", job_id, step)


def get(job_id: str) -> dict | None:
    with _LOCK:
        j = _JOBS.get(job_id)
        return dict(j) if j else None
