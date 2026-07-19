"""Standalone inference server for a rented GPU (RunPod & co) — the remote half of the
⚙ remote-inference setting.

It wraps THE SAME `backend.imagegen` module the app runs locally (which picks cuda on
such a box), so local and remote generations are the same code path down to the seed.
Run it on the GPU machine from a checkout of this repo:

    pip install -r requirements.txt
    KAIKA_REMOTE_TOKEN=<secret> python -m backend.remote_app          # port 5100

then paste the box's URL (+ token) into the app's ⚙ settings. Models download from HF
on first use — the first request per model is slow once, then cached (put HF_HOME on
the persistent volume). If KAIKA_REMOTE_TOKEN is set every request must carry it as a
Bearer token; without it the server is open (fine for an SSH tunnel, not for a public
URL). Frame payloads travel as compressed npz with a JSON params header — see
backend/remote_client.py (the codec is shared).
"""

from __future__ import annotations

import json
import logging
import os

# This process IS the remote end: pin imagegen local before importing it, so a stray
# settings.json on the GPU box can never bounce a request back out (infinite loop).
os.environ["KAIKA_FORCE_LOCAL"] = "1"

from flask import Flask, Response, jsonify, request

from . import imagegen
from .remote_client import pack_npz, unpack_npz

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("kaika.remote_app")

TOKEN = os.environ.get("KAIKA_REMOTE_TOKEN", "")

app = Flask(__name__)


@app.before_request
def _auth():
    if not TOKEN:
        return None
    got = (request.headers.get("Authorization") or "").removeprefix("Bearer ").strip()
    if got != TOKEN:
        return jsonify({"error": "bad or missing token"}), 401
    return None


def _params() -> dict:
    try:
        return json.loads(request.headers.get("X-Kaika-Params") or "{}")
    except ValueError:
        return {}


def _npz_response(**arrays) -> Response:
    return Response(pack_npz(**arrays), mimetype="application/x-npz")


@app.route("/health")
def health():
    """Who am I: device + GPU name + torch version + known models. The app's ⚙
    'test connection' shows this verbatim."""
    import torch

    device = imagegen._pick_device()
    gpu = torch.cuda.get_device_name(0) if device == "cuda" else device
    return jsonify(
        {
            "ok": True,
            "device": device,
            "gpu": gpu,
            "torch": torch.__version__,
            "models": {m: s["label"] for m, s in imagegen.MODELS.items()},
        }
    )


@app.route("/stylize", methods=["POST"])
def stylize():
    """npz(frames[, control]) + params header → npz(styled). Batching/progress live on
    the CLIENT (remote_client.stylize_remote); one request = one batch, run verbatim."""
    arrays = unpack_npz(request.get_data())
    p = _params()
    try:
        styled = imagegen.stylize_frames(
            arrays["frames"],
            p.get("prompt", ""),
            strength=float(p.get("strength", 1.0)),
            inpaint=bool(p.get("inpaint", False)),
            model=p.get("model") or None,
            seed=int(p.get("seed", 1)),
            control=arrays.get("control"),
            control_scale=p.get("control_scale"),
            negative=p.get("negative") or "blurry, low quality, watermark, text",
            short=p.get("short"),
        )
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 500
    return _npz_response(styled=styled)


@app.route("/generate", methods=["POST"])
def generate():
    """params header → npz(im0..imN) of generated images (PNG-lossless uint8 RGB)."""
    import numpy as np

    p = _params()
    try:
        images = imagegen.generate(
            p.get("prompt", ""),
            seed=int(p.get("seed", 1)),
            count=int(p.get("count", 1)),
            model=p.get("model") or None,
            long_edge=p.get("long_edge"),
            aspect=tuple(p["aspect"]) if p.get("aspect") else None,
        )
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 500
    return _npz_response(**{f"im{i}": np.asarray(im) for i, im in enumerate(images)})


@app.route("/depth", methods=["POST"])
def depth():
    """npz(frames) → npz(depth)."""
    arrays = unpack_npz(request.get_data())
    try:
        out = imagegen.depth_frames(arrays["frames"])
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 500
    return _npz_response(depth=out)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5100"))
    log.info(
        "Kaika remote inference — device %s, port %d, auth %s",
        imagegen._pick_device(),
        port,
        "on" if TOKEN else "OFF (no token set)",
    )
    # threaded: /health stays responsive while imagegen's _infer_lock serialises the GPU.
    app.run(host="0.0.0.0", port=port, threaded=True)
