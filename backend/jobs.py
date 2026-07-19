"""Tiny in-process job manager.

Runs slow work (yt-dlp, demucs, Whisper, diffusion) off the Flask request thread so
``/upload`` and ``/segment`` return a job id immediately and the UI polls
``/jobs/<id>`` for progress. Single-process, with a small twist: every state
change is SNAPSHOTTED to ``data/jobs_state.json``. The dev reloader restarts the
server on any backend file save, killing the worker threads — without the
snapshot every in-flight generation then 404'd as "unknown job" at the next
poll. Now a restart restores the map: finished jobs keep answering polls with
their result, and jobs that died mid-run answer with a CLEAR error instead.

A small thread pool runs the work; the default of one worker keeps two demucs
separations from fighting over the GPU at once, and means matplotlib's pyplot
state is only ever touched by one (consistent) worker thread.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from . import paths
from .job_table import prune_jobs
from .config import MAX_JOB_RECORDS

_POOL = ThreadPoolExecutor(max_workers=int(os.environ.get("JOB_WORKERS", "1")))
_LOCK = threading.Lock()
_JOBS: dict[str, dict] = {}
_MAX_JOBS = MAX_JOB_RECORDS  # prune finished jobs beyond this (most-recent kept)
_log = logging.getLogger("kaika.jobs")

RESTART_ERROR = "the server restarted mid-job (a backend file changed) — run it again"


def _save_locked() -> None:
    """Snapshot the job map (callers hold _LOCK). Best-effort — a failed write only
    costs restart-survival, never the job itself. `default=str` keeps an exotic
    result value from poisoning the whole snapshot."""
    try:
        paths.JOBS_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        paths.JOBS_STATE_FILE.write_text(json.dumps(_JOBS, default=str))
    except OSError:
        _log.warning("could not snapshot job state", exc_info=True)


def _restore() -> None:
    """Load the snapshot at import (i.e. after every reloader restart). Jobs that
    were `running` when the process died can never finish — mark them as a clear
    error so the UI says what happened instead of 404ing."""
    try:
        stored = json.loads(paths.JOBS_STATE_FILE.read_text())
    except (OSError, ValueError):
        return
    if not isinstance(stored, dict):
        return
    for jid, j in stored.items():
        if not isinstance(j, dict) or "state" not in j:
            continue
        if j["state"] == "running":
            j.update(state="error", error=RESTART_ERROR)
        _JOBS[jid] = j
    if _JOBS:
        _log.info("restored %d job record(s) from the last run", len(_JOBS))


_restore()


def _prune_locked() -> None:
    """Drop the oldest finished jobs once the map exceeds `_MAX_JOBS`, so a long-lived
    server doesn't grow one entry per upload forever."""
    prune_jobs(_JOBS, _MAX_JOBS)


def submit(job_id: str, step: str, fn) -> None:
    """Register ``job_id`` as running and run ``fn()`` in the background.

    ``fn`` returns the result dict (stored and exposed when the job finishes);
    any exception it raises marks the job failed with the message.
    """
    with _LOCK:
        _JOBS[job_id] = {
            "state": "running",
            "step": step,
            "error": None,
            "result": None,
            "updated": time.time(),
        }
        _prune_locked()
        _save_locked()

    _log.info("job %s started (%s)", job_id, step)

    def _run():
        try:
            result = fn()
            with _LOCK:
                if job_id in _JOBS:
                    _JOBS[job_id].update(
                        state="done", step="done", result=result, updated=time.time()
                    )
                    _save_locked()
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
                    _save_locked()

    _POOL.submit(_run)


def set_step(job_id: str, step: str) -> None:
    with _LOCK:
        if job_id in _JOBS:
            _JOBS[job_id].update(step=step, updated=time.time())
            _save_locked()
    _log.info("job %s → %s", job_id, step)


def get(job_id: str) -> dict | None:
    with _LOCK:
        j = _JOBS.get(job_id)
        return dict(j) if j else None
