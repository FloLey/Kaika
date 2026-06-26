"""Tests for the in-process job manager (B8.3)."""

import threading
import time

from backend import jobs


def _wait(job_id: str, timeout: float = 2.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        j = jobs.get(job_id)
        if j and j["state"] in ("done", "error"):
            return j
        time.sleep(0.01)
    raise AssertionError(f"job {job_id} did not finish in {timeout}s")


def test_job_runs_to_done_and_stores_result():
    jobs.submit("t-done", "working", lambda: {"ok": 1})
    j = _wait("t-done")
    assert j["state"] == "done" and j["step"] == "done" and j["result"] == {"ok": 1}


def test_job_failure_records_typed_error():
    def boom():
        raise ValueError("nope")

    jobs.submit("t-fail", "working", boom)
    j = _wait("t-fail")
    assert j["state"] == "error" and "ValueError: nope" in j["error"]


def test_set_step_updates_a_running_job():
    started, release = threading.Event(), threading.Event()

    def slow():
        started.set()
        release.wait(1.0)
        return {}

    jobs.submit("t-step", "step-a", slow)
    assert started.wait(1.0)
    jobs.set_step("t-step", "step-b")
    assert jobs.get("t-step")["step"] == "step-b"
    release.set()
    _wait("t-step")


def test_get_unknown_is_none():
    assert jobs.get("does-not-exist") is None


def test_get_returns_a_copy():
    jobs.submit("t-copy", "s", lambda: {})
    _wait("t-copy")
    snapshot = jobs.get("t-copy")
    snapshot["state"] = "mutated"
    assert jobs.get("t-copy")["state"] == "done"  # internal state untouched
