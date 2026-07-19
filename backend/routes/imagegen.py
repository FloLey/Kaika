"""Local image generation — the Image gen card's sparkle button.

Runs on the ingestion job queue (one worker) so a generation waits politely behind a
running separation instead of fighting it for the GPU.
"""

from __future__ import annotations

import logging
from uuid import uuid4

from flask import Blueprint, jsonify

from .. import db
from .. import jobs
from ..web import json_body, validate_job_id, error_response
from .assets import _store_asset

bp = Blueprint("imagegen", __name__)
log = logging.getLogger("kaika")


@bp.route("/generate-image/<job_id>", methods=["POST"])
@json_body
def generate_image(body, job_id):
    """Generate image(s) locally (a local diffusion model on MPS — see backend/imagegen.py)
    and store them as library assets. Runs on the SAME single-worker job queue as
    demucs/Whisper so GPU work never overlaps; the Image gen card polls /jobs/<id>
    for `{assets: [...]}` and appends the URLs to its slideshow."""
    if not validate_job_id(job_id):
        return error_response("bad job id", 404)
    from .. import imagegen

    # One image per prompt (the Image gen card sends its whole prompts list);
    # a bare `prompt` string still works for single generations.
    prompts = body.get("prompts")
    if not isinstance(prompts, list):
        prompts = [body.get("prompt") or ""]
    prompts = [str(p).strip() for p in prompts if str(p).strip()]
    if not prompts:
        return error_response("provide at least one prompt", 400)
    prompts = prompts[:8]  # bound a single request
    seed = int(body.get("seed") or 1)
    # The card's ✨ makes fast, low-res DRAFTS by default (the HD pass runs at export);
    # a valid `model` in the body overrides which model the draft uses.
    model = body.get("model")
    if model not in imagegen.MODELS:
        model = imagegen.DRAFT_MODEL
    aspect = _project_aspect(job_id)
    gen_job = uuid4().hex[:8]
    jobs.submit(
        gen_job,
        "generating",
        lambda: _generate_assets(job_id, prompts, seed, model, aspect, imagegen.DRAFT_EDGE),
    )
    return jsonify({"job_id": gen_job})


def _project_aspect(job_id: str) -> tuple:
    """The project's preview output (width, height) — the aspect generated images
    follow. Falls back to portrait 1080x1920 when unset."""
    row = db.get_project(job_id)
    out = ((row or {}).get("data") or {}).get("output") or {}
    return (int(out.get("width") or 1080), int(out.get("height") or 1920))


def _generate_assets(
    job_id: str, prompts: list, seed: int, model: str, aspect: tuple, long_edge: int
) -> dict:
    """Background worker: ONE image per prompt (image i seeded seed+i), PNG-encoded
    and registered as content-addressed library assets (identical generations dedupe
    and the render cache stays correct). Raises with a clean message when the model
    stack isn't available — the job error surfaces on the card."""
    import io

    from .. import imagegen

    assets = []
    for i, prompt in enumerate(prompts):
        img = imagegen.generate(
            prompt, seed=seed + i, count=1, model=model, aspect=aspect, long_edge=long_edge
        )[0]
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        assets.append(
            _store_asset(job_id, buf.getvalue(), f"gen-{seed + i}-{prompt[:24]}.png", kind="image")
        )
    return {"assets": assets}
