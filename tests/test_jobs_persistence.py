"""Jobs must survive the dev reloader: finished results keep answering polls after a
restart, and a job that died mid-run answers with a clear error instead of a 404."""

import json
import time

from backend import jobs, paths


def _with_tmp_state(monkeypatch, tmp_path):
    f = tmp_path / "jobs_state.json"
    monkeypatch.setattr(paths, "JOBS_STATE_FILE", f)
    monkeypatch.setattr(jobs, "_JOBS", {})
    return f


def _wait_done(job_id, timeout=5.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = jobs.get(job_id)
        if j and j["state"] != "running":
            return j
        time.sleep(0.02)
    raise AssertionError("job never finished")


def test_finished_job_survives_a_restart(monkeypatch, tmp_path):
    f = _with_tmp_state(monkeypatch, tmp_path)
    jobs.submit("finjob01", "working", lambda: {"assets": [1, 2]})
    assert _wait_done("finjob01")["state"] == "done"
    assert json.loads(f.read_text())["finjob01"]["state"] == "done"
    # simulate the reloader: fresh empty map, then restore from the snapshot
    monkeypatch.setattr(jobs, "_JOBS", {})
    assert jobs.get("finjob01") is None
    jobs._restore()
    j = jobs.get("finjob01")
    assert j["state"] == "done" and j["result"] == {"assets": [1, 2]}


def test_job_killed_mid_run_reports_a_clear_error(monkeypatch, tmp_path):
    f = _with_tmp_state(monkeypatch, tmp_path)
    # a running job as the snapshot would leave it when the process dies
    f.write_text(
        json.dumps(
            {
                "midjob01": {
                    "state": "running",
                    "step": "frame 3/72",
                    "error": None,
                    "result": None,
                    "updated": 0.0,
                }
            }
        )
    )
    jobs._restore()
    j = jobs.get("midjob01")
    assert j["state"] == "error" and j["error"] == jobs.RESTART_ERROR


def test_corrupt_snapshot_is_ignored(monkeypatch, tmp_path):
    f = _with_tmp_state(monkeypatch, tmp_path)
    f.write_text("{broken")
    jobs._restore()  # must not raise
    assert jobs.get("anything") is None
