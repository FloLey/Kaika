"""Project routes — the resumable per-song state (segments, output, step)."""

import json
import shutil

from flask import Blueprint, abort, jsonify, request

from .. import db
from ..paths import UPLOAD_DIR, SEPARATED_DIR, SPECTRO_DIR, ANALYSIS_DIR, ASSETS_DIR

bp = Blueprint("projects", __name__)


@bp.route("/projects", methods=["GET"])
def projects_list():
    return jsonify(db.list_projects())


@bp.route("/playground", methods=["POST"])
def playground_ensure():
    """Ensure the always-present Playground project exists (built lazily on first open)
    and return its job id. Idempotent — a near no-op once present."""
    from .. import seed_card_demo  # local import: pulls numpy/soundfile/matplotlib lazily

    return jsonify({"job_id": seed_card_demo.ensure_playground()})


@bp.route("/playground/export", methods=["POST"])
def playground_export():
    """The Playground's 💾 save-fixture button: capture the live Playground into the
    committed fixture (backend/playground_pipelines.json) so the next seed rebuilds
    from the current state — the in-app twin of `make export-playground`. Returns the
    export summary; `missing` non-empty means a card lost its demo (the CI card-impact
    test would fail), so the UI shows it as a warning."""
    from .. import seed_card_demo

    try:
        return jsonify(seed_card_demo.export_playground())
    except LookupError as e:
        return jsonify({"error": str(e)}), 404


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
    return jsonify(
        {
            "job_id": row["job_id"],
            "title": row["title"],
            "duration": row["duration"],
            "fmin": row["fmin"],
            "has_lyrics": row["has_lyrics"],
            "step": row["step"],
            "stems": data.get("stems", {}),
            "segments": data.get("segments", []),
            "output": data.get("output") or {},
            "export": data.get("export") or {},
            "assets": data.get("assets") or [],
            "vocal_envelope": analysis.get("vocal_envelope", []),
            "envelope_times": analysis.get("envelope_times", []),
            "lyric_lines": analysis.get("lyric_lines", []),
        }
    )


def _save_lyric_lines(job_id: str, lines: list) -> None:
    """Overwrite the aligned lyric lines in the analysis cache — the same file
    `project_get` serves them from. Lets the user rewrite line TEXT in-app (the
    wedding-lyrics flow: upload the original words for good Whisper timing, then
    swap in new words per line) while keeping the aligned timings. Only sane
    entries are kept; timings are coerced to floats."""
    clean = [
        {
            "t0": float(ln.get("t0", 0.0)),
            "t1": float(ln.get("t1", 0.0)),
            "text": str(ln.get("text", "")),
            # Preserve the aligned flag when present (display styling hint).
            **({"aligned": bool(ln["aligned"])} if "aligned" in ln else {}),
        }
        for ln in lines
        if isinstance(ln, dict)
    ]
    cache = ANALYSIS_DIR / f"{job_id}.json"
    analysis = json.loads(cache.read_text()) if cache.exists() else {}
    analysis["lyric_lines"] = clean
    cache.write_text(json.dumps(analysis))


@bp.route("/projects/<job_id>", methods=["PUT"])
def project_save(job_id: str):
    body = request.get_json(silent=True) or {}
    ok = db.save_segments(
        job_id,
        body.get("segments", []),
        step=body.get("step"),
        title=body.get("title"),
        output=body.get("output"),
        export=body.get("export"),
    )
    if not ok:
        abort(404)
    # Optional: edited lyric lines ride the same autosave PUT (analysis cache, not DB).
    if isinstance(body.get("lyric_lines"), list):
        _save_lyric_lines(job_id, body["lyric_lines"])
    # Note: no cache GC here on purpose — sweeping mid-session could unlink a preview
    # clip a still-open editor is playing, and it would add DB-walk latency to every
    # save. The startup sweep (app.py) + `make gc-cache` + render_cache's size/age cap
    # keep the cache bounded instead.
    return jsonify({"ok": True})


@bp.route("/projects/<job_id>", methods=["DELETE"])
def project_delete(job_id: str):
    existed = db.delete_project(job_id)
    for d in (UPLOAD_DIR, SEPARATED_DIR, SPECTRO_DIR, ASSETS_DIR):
        shutil.rmtree(d / job_id, ignore_errors=True)
    (ANALYSIS_DIR / f"{job_id}.json").unlink(missing_ok=True)
    if not existed:
        abort(404)
    return jsonify({"ok": True})
