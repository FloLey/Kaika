"""AI Stylize card: run per-frame diffusion (img2img, optionally inpaint) over a fluid
clip as a background job, storing the result as a content-addressed mp4 asset that the
render handler decodes. Same job/asset shape as the Image gen card (`/generate-image`)."""

import logging
import os
import tempfile
from pathlib import Path
from uuid import uuid4

from flask import Blueprint, jsonify

from .. import db
from .. import graph as graphmod
from .. import imagegen
from .. import jobs
from .. import fluid
from ..media import stem_audio_path
from ..web import json_body, validate_job_id, error_response
from .uploads import _store_asset

log = logging.getLogger("kaika")

bp = Blueprint("stylize", __name__)


@bp.post("/stylize/<job_id>")
@json_body
def stylize(body, job_id):
    """Start an AI-stylize job for one `stylize` node -> {job_id}. Renders the upstream
    fluid clip, diffuses each frame, stores an mp4 asset. The card polls /jobs/<id> for
    {assets:[{url}]} and writes the url into node.data.assetUrl."""
    if not validate_job_id(job_id):
        return error_response("bad job id", 404)
    graph = body.get("graph")
    segment = body.get("segment")
    output = body.get("output")
    node_id = body.get("node_id")
    if graph is None or segment is None or not node_id:
        return error_response("missing graph, segment, or node_id", 400)
    node = next((n for n in graph.get("nodes", []) if n.get("id") == node_id), None)
    if node is None or node.get("type") != "stylize":
        return error_response("no such stylize node", 400)
    d = node.get("data") or {}
    model = imagegen.HD_MODEL if d.get("model") == "hd" else imagegen.DRAFT_MODEL
    inpaint = bool(d.get("inpaint", False))
    prompt = str(d.get("prompt") or "flowers")
    gen_job = uuid4().hex[:8]
    jobs.submit(
        gen_job,
        "stylizing",
        lambda: _stylize_job(
            gen_job, job_id, segment, graph, node_id, output, prompt, inpaint, model
        ),
    )
    return jsonify({"job_id": gen_job})


def _stylize_job(gen_job, job_id, segment, graph, node_id, output, prompt, inpaint, model) -> dict:
    """Worker: render the upstream clip (reuses the render DAG), diffuse each frame, encode
    an mp4, and store it as a content-addressed video asset. Reports per-frame progress via
    the job step so the card shows a progress bar. Raises a clean message the job surfaces
    on the card when the diffusion stack / model isn't available."""
    jobs.set_step(gen_job, "rendering source")
    frames, strength, fps, control = graphmod.stylize_source(
        job_id, segment, graph, node_id, stem_audio_path, output
    )
    styled = imagegen.stylize_frames(
        frames,
        prompt,
        strength=strength,
        inpaint=inpaint,
        model=model,
        control=control,
        # short=None → per-model preview size: draft 384 (fast iteration), HD 576 — the
        # empirical floor below which Z-Image paints blobs instead of subjects.
        short=None,
        on_progress=lambda done, total: jobs.set_step(gen_job, f"frame {done}/{total}"),
    )
    jobs.set_step(gen_job, "encoding")
    tmp = Path(tempfile.mkdtemp(prefix=f"stylize-{job_id}-"))
    try:
        clip = tmp / "clip.mp4"
        # keep the diffusion aspect (VideoClip re-fits to the grid at decode time)
        fluid.render_mp4(styled, int(fps), clip, out_w=styled.shape[2], out_h=styled.shape[1])
        data = clip.read_bytes()
    finally:
        try:
            for p in tmp.iterdir():
                p.unlink()
            os.rmdir(tmp)
        except OSError:
            pass
    label = model.split("/")[-1]
    asset = _store_asset(job_id, data, f"stylize-{label}.mp4", kind="video")
    _persist_asset_url(job_id, node_id, asset["url"])
    return {"assets": [asset]}


def _persist_asset_url(job_id: str, node_id: str, url: str) -> None:
    """Write the generated clip's URL onto its node in the DB, server-side.

    The card's own poll does the same write when its tab is open — but an HD clip takes
    tens of minutes, and a reload/close mid-job used to orphan the finished asset (the
    only writer was the browser). This is the durable copy; the client write is idempotent
    on top of it. Reads the CURRENT graph (not the job's snapshot) so edits made during
    the run survive; a project/node deleted mid-job just logs. Best-effort by design —
    the job result still carries the asset either way."""
    try:
        row = db.get_project(job_id)
        if row is None:
            return
        segments = row["data"]["segments"]
        hit = False
        for seg in segments:
            for n in (seg.get("graph") or {}).get("nodes", []):
                if n.get("id") == node_id and n.get("type") == "stylize":
                    n.setdefault("data", {})["assetUrl"] = url
                    hit = True
        if hit:
            db.save_segments(job_id, segments)
            log.info("stylize: persisted %s onto node %s", url, node_id)
    except Exception:  # noqa: BLE001 — never fail the job at the finish line
        log.warning("stylize: could not persist assetUrl onto node %s", node_id, exc_info=True)
