"""Small HTTP helpers shared by the routes: a JSON-body decorator and request
parameter validation. Keeping these here (not in app.py) means routes — and a future
blueprint split — can import them without a cycle back through the app object.
"""
from __future__ import annotations

from functools import wraps

from flask import jsonify, request


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
    if not (0.0 < min_hz <= max_hz <= 20000.0):
        raise ValueError(f"invalid band: minHz={min_hz}, maxHz={max_hz}")
    if not (1 <= fps <= 240):
        raise ValueError(f"invalid fps: {fps}")
    return start, end, min_hz, max_hz, fps
