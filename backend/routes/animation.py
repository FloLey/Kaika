"""Synchronous render routes: signal extraction, the fluid playground, and the
per-segment animation graph. Each catches its own errors and returns JSON before
reaching the global handler."""

import logging

from flask import Blueprint, jsonify

from .. import signals as sig
from .. import fluid
from .. import graph as graphmod
from .. import render_cache
from ..web import json_body, validate_audio_params
from ..media import stem_audio_path
from ..paths import FLUID_DIR

log = logging.getLogger("kaika")

bp = Blueprint("animation", __name__)


@bp.route("/extract", methods=["POST"])
@json_body
def extract_route(b):
    """Extract one signal's curve: (stem + frequency band + segment window)
    shaped by attack/release/invert/gamma/gain/offset/threshold -> {curve,times}.
    The frontend calls this (debounced) as bands/sliders move."""
    job_id = b.get("job_id")
    stem = b.get("stem", "original")
    src = stem_audio_path(job_id, stem) if job_id else None
    if src is None:
        return jsonify({"error": "unknown job/stem"}), 404
    try:
        start, end, min_hz, max_hz, fps = validate_audio_params(b)
        out = sig.extract(
            str(src),
            start,
            end,
            min_hz,
            max_hz,
            feature=b.get("feature", "energy"),
            fps=fps,
            attack=float(b.get("attack", 5.0)),
            release=float(b.get("release", 250.0)),
            invert=bool(b.get("invert", False)),
            gamma=float(b.get("gamma", 1.0)),
            gain=float(b.get("gain", 1.0)),
            offset=float(b.get("offset", 0.0)),
            threshold=float(b.get("threshold", 0.0)),
        )
    except (ValueError, TypeError) as e:
        log.warning("extract bad params (%s/%s): %s", job_id, stem, e)
        return jsonify({"error": str(e)}), 400
    except Exception as e:  # noqa: BLE001
        log.error("extract failed (%s/%s)", job_id, stem, exc_info=e)
        return jsonify({"error": f"{type(e).__name__}: {e}"}), 500
    return jsonify(out)


@bp.route("/fluid", methods=["POST"])
@json_body
def fluid_route(params):
    """Run the centered-source fluid sim for the given params, encode an mp4, and
    return its URL. Cached by a params hash so revisiting settings replays
    instantly (the UI loops the clip and re-runs on changes)."""
    h = fluid.params_hash(params)
    out = FLUID_DIR / f"{h}.mp4"
    if out.exists():
        render_cache.touch(out)  # keep this hot clip from aging out (LRU)
    else:
        try:
            frames, fps, _n = fluid.simulate(params)
            fluid.render_mp4(frames, fps, out)
        except (ValueError, KeyError, TypeError) as e:
            log.warning("fluid render bad params: %s", e)
            return jsonify({"error": str(e)}), 400
        except Exception as e:  # noqa: BLE001
            log.error("fluid render failed", exc_info=e)
            return jsonify({"error": f"{type(e).__name__}: {e}"}), 500
        render_cache.evict(FLUID_DIR)  # bound the cache after adding a clip
    return jsonify({"url": f"/fluid/{h}.mp4"})


@bp.post("/animate")
@json_body
def animate(body):
    """Render a per-segment graph (`01`) to a cached, looping mp4 -> {url}.

    The request carries the live signal defs (`segment.signals`, Issue 1A) so the
    executor needs no DB read. Output is written under data/fluid/ and served by
    the existing `/fluid/<name>` route. Bad graph -> HTTP 400.
    """
    job_id = body.get("job_id")
    graph = body.get("graph")
    segment = body.get("segment")  # { start, end, signals: [...] }
    output = body.get("output")  # project render settings (size/quality/fps/bg)
    output_id = body.get("output_id")  # which output's pipeline to render (N per graph)
    if not job_id or graph is None or segment is None:
        return jsonify({"error": "missing job_id, segment, or graph"}), 400
    try:
        url = graphmod.render(job_id, segment, graph, stem_audio_path, output, output_id)
    except ValueError as e:
        log.warning("animate rejected graph (%s): %s", job_id, e)
        return jsonify({"error": str(e)}), 400
    except Exception as e:  # noqa: BLE001
        log.error("animate failed (%s)", job_id, exc_info=e)
        return jsonify({"error": f"{type(e).__name__}: {e}"}), 500
    return jsonify({"url": url})
