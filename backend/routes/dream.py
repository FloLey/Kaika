"""Dream card: generate one image per frame — pure txt2img + ControlNet, following a
wired control track and a prompt schedule — as a background job, storing the result as a
content-addressed mp4 the render handler decodes. Same job/asset shape as AI Stylize.

Generation is never run inside a render request: a handler taking seconds per frame would
freeze the render pool and every live preview. Explicit button -> `jobs.py` job on the one
GPU worker -> asset on disk -> cheap decode-only handler.
"""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path
from uuid import uuid4

from flask import Blueprint, jsonify

from .. import fluid
from .. import graph as graphmod
from .. import imagegen
from .. import jobs
from ..media import stem_audio_path
from ..web import json_body, validate_job_id, error_response
from ._gpu import submit_generation
from ._node_assets import persist_asset_url
from .uploads import _store_asset

log = logging.getLogger("kaika")

bp = Blueprint("dream", __name__)


@bp.post("/dream/<job_id>")
@json_body
def dream(body, job_id):
    """Start a Dream job for one `dream` node -> {job_id}. Renders the upstream control
    (and, when wired, the `video` start clip), generates a frame per plan entry, stores an
    mp4 asset. The card polls /jobs/<id> for {assets:[{url}]} and writes the url into
    node.data.assetUrl."""
    if not validate_job_id(job_id):
        return error_response("bad job id", 404)
    graph = body.get("graph")
    segment = body.get("segment")
    output = body.get("output")
    node_id = body.get("node_id")
    if graph is None or segment is None or not node_id:
        return error_response("missing graph, segment, or node_id", 400)
    node = next((n for n in graph.get("nodes", []) if n.get("id") == node_id), None)
    if node is None or node.get("type") != "dream":
        return error_response("no such dream node", 400)
    d = node.get("data") or {}
    if not (d.get("prompts") or []):
        return error_response("dream node has no prompts", 400)
    model = imagegen.HD_MODEL if d.get("model") == "hd" else imagegen.DRAFT_MODEL
    gen_job = uuid4().hex[:8]
    refused = submit_generation(
        gen_job,
        "dreaming",
        lambda: _dream_job(gen_job, job_id, segment, graph, node_id, output, model),
    )
    return refused or jsonify({"job_id": gen_job})


def _dream_job(gen_job, job_id, segment, graph, node_id, output, model) -> dict:
    """Worker: render the input clips + resolve the schedule (reusing the render DAG),
    generate each frame, encode an mp4, store it as a content-addressed video asset.

    Reports per-frame progress via the job step. On a warm frame cache the progress bar
    races through — that is `dream_frames` counting hits, not a stall."""
    jobs.set_step(gen_job, "rendering inputs")
    control, init, plan, fps = graphmod.dream_source(
        job_id, segment, graph, node_id, stem_audio_path, output
    )
    frames = imagegen.dream_frames(
        control,
        plan,
        init=init,
        model=model,
        # short=None -> per-model preview size: draft 384, HD 576 (the floor below which
        # Z-Image paints blobs). The export passes a larger one.
        short=None,
        on_progress=lambda done, total: jobs.set_step(gen_job, f"frame {done}/{total}"),
    )
    jobs.set_step(gen_job, "encoding")
    tmp = Path(tempfile.mkdtemp(prefix=f"dream-{job_id}-"))
    try:
        clip = tmp / "clip.mp4"
        # keep the diffusion aspect (VideoClip re-fits to the grid at decode time)
        fluid.render_mp4(frames, int(fps), clip, out_w=frames.shape[2], out_h=frames.shape[1])
        data = clip.read_bytes()
    finally:
        try:
            for p in tmp.iterdir():
                p.unlink()
            os.rmdir(tmp)
        except OSError:
            pass
    label = model.split("/")[-1]
    asset = _store_asset(job_id, data, f"dream-{label}.mp4", kind="video")
    persist_asset_url(job_id, node_id, "dream", asset["url"])
    return {"assets": [asset]}
