"""Small HTTP helpers shared by the routes: a JSON-body decorator and request
parameter validation. Keeping these here (not in app.py) means routes — and a future
blueprint split — can import them without a cycle back through the app object.
"""

from __future__ import annotations

import re
from functools import wraps

from flask import jsonify, request

# Job ids are uuid4().hex[:8] (8 lowercase hex chars). Validating the shape lets
# routes reject nonsense early with a clear 400 instead of a downstream None/404.
# (Not a security boundary — Flask's <string> converter already excludes '/'.)
_JOB_ID_RE = re.compile(r"^[a-f0-9]{8}$")


def validate_job_id(job_id) -> bool:
    """True if ``job_id`` is the canonical 8-char hex shape (or the app-managed
    "playground", which serves its bundled sample assets like any project)."""
    return bool(job_id and isinstance(job_id, str) and (_JOB_ID_RE.match(job_id) or job_id == "playground"))


# Asset ids / filename stems: content-addressed sha16 (alnum), plus the HD-export
# assets the whole-song render generates as `hd-<sha16>`. Interior hyphens are the
# only extra character allowed — a hyphen can't express a path traversal, and dots
# and slashes stay excluded, so this is as tight as the alnum check it replaced.
_ASSET_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]*$")


def validate_asset_id(s) -> bool:
    """True if ``s`` is a safe asset id / file stem (alnum + interior hyphens)."""
    return bool(s and isinstance(s, str) and _ASSET_ID_RE.match(s))


def error_response(message: str, code: int = 400):
    """The one route-level error shape: ``{"error": message}`` with a status."""
    return jsonify({"error": message}), code


def json_body(fn):
    """Route decorator: require a JSON OBJECT body (400 otherwise) and pass it as the
    first positional arg. Path params still arrive as keyword args, e.g.

        @app.route("/x", methods=["POST"])
        @json_body
        def handler(body): ...
    """

    @wraps(fn)
    def wrapper(*args, **kwargs):
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return jsonify({"error": "body must be a JSON object"}), 400
        return fn(body, *args, **kwargs)

    return wrapper


def validate_audio_params(b: dict) -> tuple[float, float, float, float, int]:
    """Coerce + bounds-check the /extract numeric params. Raises ValueError (which the
    route maps to a 400) on a nonsensical window / band / fps, so garbage-in fails
    loudly instead of silently producing a flat or wrong curve."""
    start = float(b.get("start", 0.0))
    end = float(b.get("end", 0.0))
    min_hz = float(b.get("minHz", 20.0))
    max_hz = float(b.get("maxHz", 20000.0))
    fps = int(b.get("fps", 30))
    if not (0.0 <= start < end):
        raise ValueError(f"invalid window: start={start}, end={end}")
    # maxHz goes up to the stem's Nyquist (sr/2) — 22050 at 44.1k, 24000 at 48k, and
    # higher for hi-res audio — so only require a positive, ordered band with a
    # generous sanity ceiling (192kHz audio -> 96k Nyquist), not a 20kHz cap.
    if not (0.0 < min_hz <= max_hz <= 96000.0):
        raise ValueError(f"invalid band: minHz={min_hz}, maxHz={max_hz}")
    if not (1 <= fps <= 240):
        raise ValueError(f"invalid fps: {fps}")
    return start, end, min_hz, max_hz, fps
