"""The streaming-render job manager.

`jobs.py` (song ingestion) has two test files; its sibling had none, while
ARCHITECTURE.md calls cancel-on-edit a core behaviour of the editor — the UI cancels the
previous render on EVERY graph edit, so this manager runs constantly and nothing checked
it. `routes/export.py` also depends on the `phase=` kwarg contract pinned below.

Threading is driven with Events rather than sleeps so the tests are deterministic.
"""

from __future__ import annotations

import threading
import time

import pytest

from backend import render_jobs


@pytest.fixture(autouse=True)
def clean_registry():
    """Each test starts from an empty job table (the module is process-global)."""
    with render_jobs._LOCK:
        render_jobs._JOBS.clear()
    yield
    with render_jobs._LOCK:
        render_jobs._JOBS.clear()


def _await(predicate, timeout=5.0):
    """Spin until `predicate()` or fail — the pool runs jobs on another thread."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.005)
    return False


def test_a_finished_job_reports_done_and_its_url():
    rid = render_jobs.start(lambda on_progress, should_cancel: "/fluid/abc.mp4")
    assert _await(lambda: render_jobs.get(rid)["state"] == "done")
    assert render_jobs.get(rid)["url"] == "/fluid/abc.mp4"
    assert render_jobs.get(rid)["error"] is None


def test_a_raising_job_reports_error_with_the_exception_type():
    def boom(on_progress, should_cancel):
        raise RuntimeError("encoder died")

    rid = render_jobs.start(boom)
    assert _await(lambda: render_jobs.get(rid)["state"] == "error")
    # The UI surfaces this string, so the type prefix is part of the contract.
    assert render_jobs.get(rid)["error"] == "RuntimeError: encoder died"
    assert render_jobs.get(rid)["url"] is None


def test_cancel_is_visible_to_the_running_job_and_marks_it_cancelled():
    """Cancel-on-edit: the job must SEE the flag between blocks, and the final state must
    be `cancelled`, not `done` — the UI distinguishes them."""
    started, saw_cancel = threading.Event(), threading.Event()

    def run(on_progress, should_cancel):
        started.set()
        assert _await(should_cancel, 5.0), "cancel flag never reached the job"
        saw_cancel.set()
        return None

    rid = render_jobs.start(run)
    assert started.wait(5.0)
    assert render_jobs.cancel(rid) is True
    assert saw_cancel.wait(5.0)
    assert _await(lambda: render_jobs.get(rid)["state"] == "cancelled")


def test_cancelling_an_unknown_id_is_false_not_an_error():
    assert render_jobs.cancel("nope") is False
    assert render_jobs.get("nope") is None


def test_progress_updates_the_counters():
    release = threading.Event()

    def run(on_progress, should_cancel):
        on_progress(3, 10, "/fluid/partial.mp4")
        release.wait(5.0)
        return "/fluid/done.mp4"

    rid = render_jobs.start(run)
    assert _await(lambda: render_jobs.get(rid)["frames_done"] == 3)
    j = render_jobs.get(rid)
    assert (j["total"], j["preview_url"]) == (10, "/fluid/partial.mp4")
    release.set()


def test_naming_a_phase_does_not_rewind_the_progress_bar():
    """`on_progress(phase="audio")` announces a step WITHOUT touching the frame counters
    or the preview url. routes/export.py calls it exactly that way during the HD export's
    non-frame work (image regen, mux); if it reset the counters the bar would jump back
    to 0% mid-export."""
    release = threading.Event()

    def run(on_progress, should_cancel):
        on_progress(7, 10, "/fluid/partial.mp4")
        on_progress(phase="audio")
        release.wait(5.0)
        return "/fluid/done.mp4"

    rid = render_jobs.start(run)
    assert _await(lambda: render_jobs.get(rid)["phase"] == "audio")
    j = render_jobs.get(rid)
    assert (j["frames_done"], j["total"], j["preview_url"]) == (7, 10, "/fluid/partial.mp4")
    release.set()


def test_get_never_leaks_the_cancel_event():
    """The Event is internal state; `get` feeds a JSON route, so leaking it would make
    the response unserialisable."""
    rid = render_jobs.start(lambda on_progress, should_cancel: None)
    assert _await(lambda: render_jobs.get(rid)["state"] == "done")
    assert "cancel" not in render_jobs.get(rid)


def test_prune_drops_the_oldest_finished_jobs_only(monkeypatch):
    """The table is capped. Pruning must evict FINISHED jobs oldest-first and never touch
    a running one — evicting a live render would orphan it (its progress writes find no
    record and the UI polls a 404 forever)."""
    monkeypatch.setattr(render_jobs, "_MAX_JOBS", 3)
    with render_jobs._LOCK:
        render_jobs._JOBS.clear()
        for i, (state, updated) in enumerate(
            [("done", 100.0), ("running", 101.0), ("done", 102.0), ("error", 103.0)]
        ):
            render_jobs._JOBS[f"j{i}"] = {"state": state, "updated": updated}
        render_jobs._prune_locked()
        left = set(render_jobs._JOBS)

    assert "j1" in left, "pruning evicted a RUNNING job"
    assert "j0" not in left, "pruning kept the oldest finished job"
    assert len(left) == 3
