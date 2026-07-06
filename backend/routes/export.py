"""Final-export route: render the whole song as one continuous HD video.

Loads the project's segments/graphs/output/export settings + lyric lines from the DB
(so the client sends only a job_id), then streams `song_render.render_song` as a
background job — same poll/cancel contract as `/animate/stream`.
"""

import hashlib
import json
import logging
import time

from flask import Blueprint, jsonify

from .. import db
from .. import render_jobs
from .. import song_render
from ..media import stem_audio_path
from ..paths import ANALYSIS_DIR, ASSETS_DIR
from ..web import json_body, error_response

log = logging.getLogger("kaika")

bp = Blueprint("export", __name__)

# Sensible HD defaults when a project hasn't set export settings yet: portrait 1080x1920,
# 30fps, a grid finer than the 'high' preset (144) for a crisp master, and a 1024px
# long edge for the HD regeneration of Image-gen cards.
_EXPORT_DEFAULTS = {"width": 1080, "height": 1920, "fps": 30, "gridCells": 216, "imageSize": 1024}


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
        lambda on_progress, should_cancel: _export_job(
            job_id, segments, lyric_lines, export, on_progress, should_cancel
        )
    )
    return jsonify({"render_id": render_id})


def _export_job(job_id, segments, lyric_lines, export, on_progress, should_cancel):
    """The background export: FIRST regenerate every Image-gen card's images fresh in
    HD (swapping their draft assetUrls in the in-memory graph), THEN render the song.
    Regeneration is slow (Z-Image is minutes/image), so it honours cancellation."""
    _regenerate_hd_images(job_id, segments, export, should_cancel)
    if should_cancel and should_cancel():
        return None
    url = song_render.render_song(
        job_id, segments, lyric_lines, export, stem_audio_path,
        on_progress=on_progress, should_cancel=should_cancel,
    )
    if url:
        _record_export(job_id, url)
    return url


def _record_export(job_id: str, url: str) -> None:
    """Remember the finished export's cache stem (`song_<hash>`) in the analysis cache
    so `cache_gc` treats the mp4 as reachable. The stem can't always be recomputed from
    the saved project: the HD image regeneration swaps imagegen assetUrls in MEMORY
    only, so the hash the export actually rendered under differs from a recompute over
    the saved (draft) urls. Best-effort — a failed record just means the export ages
    out like any unreferenced clip."""
    stem = url.rsplit("/", 1)[-1].removesuffix(".mp4")
    try:
        cache = ANALYSIS_DIR / f"{job_id}.json"
        analysis = json.loads(cache.read_text()) if cache.exists() else {}
        stems = [s for s in analysis.get("song_exports", []) if s != stem]
        stems.append(stem)
        analysis["song_exports"] = stems[-3:]  # the last few exports per project
        cache.write_text(json.dumps(analysis))
    except (OSError, ValueError) as e:
        log.warning("export: couldn't record export stem for %s (%s)", job_id, e)


def _regenerate_hd_images(job_id, segments, export, should_cancel):
    """For every `imagegen` node across the segments, regenerate its images in HD
    (Z-Image, at the export aspect + `imageSize` long edge) and replace the node's
    `assetUrls` in place, so the export renders the HD versions (the cards keep their
    fast drafts). HD assets are content-keyed by (model, seed, size, prompt) so an
    unchanged re-export reuses them instead of re-running the model."""
    from .. import imagegen

    aspect = (int(export.get("width") or 1080), int(export.get("height") or 1920))
    long_edge = int(export.get("imageSize") or 1024)
    max_edge = imagegen.MODELS[imagegen.HD_MODEL]["max_edge"]
    w, h = imagegen._target_size(long_edge, aspect, max_edge)

    gen_nodes = [
        n
        for seg in segments
        for n in ((seg.get("graph") or {}).get("nodes") or [])
        if n.get("type") == "imagegen"
    ]
    if not gen_nodes:
        return
    total = sum(
        len([p for p in ((n.get("data") or {}).get("prompts") or []) if str(p).strip()])
        for n in gen_nodes
    )
    log.info("export: regenerating %d image(s) in HD at %dx%d", total, w, h)
    done = 0
    for n in gen_nodes:
        d = n.get("data") or {}
        prompts = [str(p) for p in (d.get("prompts") or []) if str(p).strip()]
        seed = int(d.get("seed") or 1)
        urls = []
        for i, prompt in enumerate(prompts):
            if should_cancel and should_cancel():
                return
            key = hashlib.sha256(
                f"{imagegen.HD_MODEL}|{seed + i}|{w}x{h}|{prompt}".encode()
            ).hexdigest()[:16]
            name = f"hd-{key}.png"
            dest = ASSETS_DIR / job_id / name
            url = f"/assets/{job_id}/{name}"
            if not dest.exists():
                done += 1
                log.info("export: HD image %d/%d — %s", done, total, prompt[:48])
                img = imagegen.generate(
                    prompt, seed=seed + i, count=1,
                    model=imagegen.HD_MODEL, aspect=aspect, long_edge=long_edge,
                )[0]
                dest.parent.mkdir(parents=True, exist_ok=True)
                img.save(dest, format="PNG")
                db.add_asset(
                    job_id,
                    {"id": f"hd-{key}", "url": url, "kind": "image", "name": name,
                     "addedAt": int(time.time())},
                )
            urls.append(url)
        n["data"] = {**d, "assetUrls": urls}


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
