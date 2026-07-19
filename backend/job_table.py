"""The bookkeeping the two in-memory job managers share.

`jobs.py` (song ingestion) and `render_jobs.py` (streaming renders) are deliberately
separate — a long render must never queue behind a demucs/Whisper worker, and vice
versa — but they keep the same shaped table and bounded it with the same function,
written out twice. `jobs.py`'s docstring even said "mirrors `render_jobs._prune_locked`",
which is a comment doing a helper's job.
"""

from __future__ import annotations


def prune_jobs(jobs: dict, maximum: int) -> None:
    """Drop the oldest FINISHED jobs until `jobs` is within `maximum`.

    Never evicts a running job: its progress writes would find no record and the UI
    would poll a 404 forever. Callers hold their own lock — this mutates in place.
    """
    if len(jobs) <= maximum:
        return
    finished = sorted(
        ((jid, j) for jid, j in jobs.items() if j["state"] != "running"),
        key=lambda kv: kv[1]["updated"],
    )
    for jid, _ in finished[: len(jobs) - maximum]:
        jobs.pop(jid, None)
