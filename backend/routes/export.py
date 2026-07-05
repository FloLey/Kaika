"""Final-export route: render the whole song as one continuous HD video.

Loads the project's segments/graphs/output/export settings + lyric lines from the DB
(so the client sends only a job_id), then streams `song_render.render_song` as a
background job — same poll/cancel contract as `/animate/stream`.
"""

import json
import logging

from flask import Blueprint, jsonify

from .. import db
from .. import render_jobs
from .. import song_render
from ..media import stem_audio_path
from ..paths import ANALYSIS_DIR
from ..web import json_body, error_response

log = logging.getLogger("kaika")

bp = Blueprint("export", __name__)

# Sensible HD defaults when a project hasn't set export settings yet: portrait 1080x1920,
# 30fps, and a grid finer than the 'high' preset (144) for a crisp master.
_EXPORT_DEFAULTS = {"width": 1080, "height": 1920, "fps": 30, "gridCells": 216}


@bp.post("/export/stream")
@json_body
def export_stream(body):
    """Start a whole-song HD export -> {render_id}. Poll GET /export/stream/<id> and
    POST /export/stream/<id>/cancel like the animation stream. 400 if any segment lacks
    a marked final output."""
    job_id = body.get("job_id")
    if not job_id:
        return error_response("missing job_id", 400)
    row = db.get_project(job_id)
    if row is None:
        return error_response("unknown project", 404)
    data = row.get("data") or {}
    segments = data.get("segments") or []
    export = {**_EXPORT_DEFAULTS, **(data.get("export") or {})}
    cache = ANALYSIS_DIR / f"{job_id}.json"
    lyric_lines = json.loads(cache.read_text()).get("lyric_lines", []) if cache.exists() else []

    if not segments:
        return error_response("project has no segments", 400)
    missing = [s.get("id") for s in segments if not s.get("finalOutputId")]
    if missing:
        return error_response(f"mark a final output for every segment (missing: {missing})", 400)

    render_id = render_jobs.start(
        lambda on_progress, should_cancel: song_render.render_song(
            job_id, segments, lyric_lines, export, stem_audio_path,
            on_progress=on_progress, should_cancel=should_cancel,
        )
    )
    return jsonify({"render_id": render_id})


@bp.get("/export/stream/<render_id>")
def export_status(render_id):
    st = render_jobs.get(render_id)
    if st is None:
        return error_response("unknown export", 404)
    return jsonify(st)


@bp.post("/export/stream/<render_id>/cancel")
def export_cancel(render_id):
    render_jobs.cancel(render_id)
    return jsonify({"ok": True})
