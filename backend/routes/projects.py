"""Project routes — the resumable per-song state (segments, output, step)."""
import json
import shutil

from flask import Blueprint, abort, jsonify, request

from .. import db
from ..paths import UPLOAD_DIR, SEPARATED_DIR, SPECTRO_DIR, ANALYSIS_DIR

bp = Blueprint("projects", __name__)


@bp.route("/projects", methods=["GET"])
def projects_list():
    return jsonify(db.list_projects())


@bp.route("/projects/<job_id>", methods=["GET"])
def project_get(job_id: str):
    row = db.get_project(job_id)
    if row is None:
        abort(404)
    data = row.get("data") or {}
    # The expensive analysis (envelope + lyrics) lives in the filesystem cache so
    # re-opening the review screen doesn't re-run Whisper.
    analysis = {}
    cache = ANALYSIS_DIR / f"{job_id}.json"
    if cache.exists():
        analysis = json.loads(cache.read_text())
    return jsonify({
        "job_id": row["job_id"],
        "title": row["title"],
        "duration": row["duration"],
        "fmin": row["fmin"],
        "has_lyrics": row["has_lyrics"],
        "step": row["step"],
        "stems": data.get("stems", {}),
        "segments": data.get("segments", []),
        "output": data.get("output") or {},
        "vocal_envelope": analysis.get("vocal_envelope", []),
        "envelope_times": analysis.get("envelope_times", []),
        "lyric_lines": analysis.get("lyric_lines", []),
    })


@bp.route("/projects/<job_id>", methods=["PUT"])
def project_save(job_id: str):
    body = request.get_json(silent=True) or {}
    ok = db.save_segments(job_id, body.get("segments", []),
                          step=body.get("step"), title=body.get("title"),
                          output=body.get("output"))
    if not ok:
        abort(404)
    return jsonify({"ok": True})


@bp.route("/projects/<job_id>", methods=["DELETE"])
def project_delete(job_id: str):
    existed = db.delete_project(job_id)
    for d in (UPLOAD_DIR, SEPARATED_DIR, SPECTRO_DIR):
        shutil.rmtree(d / job_id, ignore_errors=True)
    (ANALYSIS_DIR / f"{job_id}.json").unlink(missing_ok=True)
    if not existed:
        abort(404)
    return jsonify({"ok": True})
