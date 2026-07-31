"""Admission for the card ✨ generations (Image-gen / AI Stylize / Dream).

Lifted out of the three routes rather than written three times, for `_node_assets.py`'s
reason: the subtlety is in the RELEASE, and a copy that forgets it wedges the slot for
the life of the process — a failure whose only symptom is that every later generation
and every HD render 409s, with nothing on screen saying why.

The rule itself lives in `backend/heavy.py`; this is just the job-shaped wrapper.
"""

from __future__ import annotations

from flask import jsonify

from .. import heavy, jobs


def submit_generation(gen_job: str, label: str, fn):
    """Claim the GPU for a card generation and submit it.

    Returns `None` when the job was admitted (the caller answers with its job id), or a
    Flask `(body, 409)` naming what already holds the device.

    The release rides in a wrapper around `fn` rather than in each worker, so it happens
    on EVERY exit — including the exception path, which is exactly the one a hand-written
    copy forgets.
    """
    busy = heavy.claim(heavy.GENERATE, gen_job)
    if busy is not None:
        body, status = heavy.refusal(busy)
        return jsonify(body), status

    def run():
        try:
            return fn()
        finally:
            heavy.release(gen_job)

    jobs.submit(gen_job, label, run)
    return None
