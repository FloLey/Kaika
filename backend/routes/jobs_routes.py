"""Job status polling and the backend log tail.

Both are pure read endpoints the UI polls while slow work runs elsewhere.
"""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from .. import jobs
from .. import logbus

bp = Blueprint("jobs", __name__)


@bp.route("/jobs/<job_id>", methods=["GET"])
def job_status(job_id: str):
    """Poll a background job: {state: running|done|error, step, error, result}."""
    j = jobs.get(job_id)
    if j is None:
        return jsonify({"error": "unknown job"}), 404
    return jsonify(j)


@bp.route("/logs", methods=["GET"])
def logs_route():
    """Incremental backend log feed for the frontend Logs panel.

    Returns {entries: [seq>since], seq: head}. MUST NOT log anything itself —
    otherwise each poll would create an entry the next poll fetches (runaway).
    """
    try:
        after = int(request.args.get("since", "0"))
    except (TypeError, ValueError):
        after = 0
    entries, seq = logbus.since(after)
    resp = jsonify({"entries": entries, "seq": seq})
    resp.headers["Cache-Control"] = "no-store"
    return resp
