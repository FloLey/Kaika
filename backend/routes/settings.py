"""App-level settings (⚙ modal): read/update `data/settings.json`, and probe the remote
inference server's /health FROM the backend — the token never reaches the browser and
there is no CORS to configure on the GPU box."""

import logging
import time

from flask import Blueprint, jsonify

from .. import settings as settings_mod
from ..web import json_body, error_response

log = logging.getLogger("kaika")

bp = Blueprint("settings", __name__)


@bp.route("/settings", methods=["GET"])
def get_settings():
    return jsonify(settings_mod.get_settings())


@bp.route("/settings", methods=["PUT", "POST"])
@json_body
def put_settings(body):
    """Merge the posted patch over the stored settings. Unknown keys are silently
    dropped (the merge only keeps the known shape), so the response is the truth."""
    if not isinstance(body, dict):
        return error_response("expected a settings object", 400)
    return jsonify(settings_mod.update_settings(body))


@bp.route("/settings/test-remote", methods=["POST"])
@json_body
def test_remote(body):
    """Probe `<url>/health` with the given (or stored) url+token and report what's
    there — device, GPU, latency — or a clean error. Runs server-side on purpose."""
    inf = settings_mod.get_settings()["inference"]
    url = (body.get("url") or inf["url"]).strip().rstrip("/")
    token = (body.get("token") if body.get("token") is not None else inf["token"]).strip()
    if not url:
        return error_response("no remote URL configured", 400)
    import requests

    headers = {"Authorization": f"Bearer {token}"} if token else {}
    t0 = time.time()
    try:
        r = requests.get(f"{url}/health", headers=headers, timeout=10)
    except requests.RequestException as e:
        return error_response(f"unreachable: {e}", 502)
    ms = int((time.time() - t0) * 1000)
    if r.status_code == 401:
        return error_response("remote refused the token (401)", 502)
    if r.status_code != 200:
        return error_response(f"remote /health returned HTTP {r.status_code}", 502)
    try:
        info = r.json()
    except ValueError:
        return error_response("remote /health returned no JSON — wrong URL?", 502)
    return jsonify({**info, "latency_ms": ms})
