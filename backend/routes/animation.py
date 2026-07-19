"""Synchronous render routes: signal extraction, the fluid playground, and the
per-segment animation graph. Each catches its own errors and returns JSON before
reaching the global handler."""

from __future__ import annotations
import logging

from flask import Blueprint, jsonify

from .. import signals as sig
from .. import fluid
from .. import graph as graphmod
from .. import render_cache
from .. import render_jobs
from ..web import json_body, validate_audio_params, validate_job_id, error_response
from ..media import stem_audio_path
from ..paths import FLUID_DIR

log = logging.getLogger("kaika")

bp = Blueprint("animation", __name__)


def _bad_job(job_id) -> bool:
    """Body job_ids reach stem/asset path resolution (glob under UPLOAD_DIR/<id>),
    so they need the same shape check the URL routes apply — a `../..` id must
    never reach the filesystem."""
    return not validate_job_id(job_id)


@bp.route("/extract", methods=["POST"])
@json_body
def extract_route(b):
    """Extract one signal's curve: (stem + frequency band + segment window)
    shaped by attack/release/invert/gamma/gain/offset/threshold -> {curve,times}.
    The frontend calls this (debounced) as bands/sliders move."""
    job_id = b.get("job_id")
    if _bad_job(job_id):
        return error_response("bad job id", 404)
    stem = b.get("stem", "original")
    src = stem_audio_path(job_id, stem) if job_id else None
    if src is None:
        return error_response("unknown job/stem", 404)
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
        return error_response(str(e), 400)
    except Exception as e:  # noqa: BLE001
        log.error("extract failed (%s/%s)", job_id, stem, exc_info=e)
        return error_response(f"{type(e).__name__}: {e}", 500)
    return jsonify(out)


def _resolve_endpoint(b, resolver, label: str):
    """The shared body of /resolve and /resolve-points: same required fields, same job
    check, same error mapping — only the resolver differs. Keeping one copy means the
    two endpoints' error contracts can't drift apart."""
    job_id = b.get("job_id")
    segment = b.get("segment")
    graph = b.get("graph")
    node_id = b.get("node_id")
    if not job_id or segment is None or graph is None or not node_id:
        return error_response("missing job_id, segment, graph, or node_id", 400)
    if _bad_job(job_id):
        return error_response("bad job id", 404)
    try:
        out = resolver(job_id, segment, graph, node_id, stem_audio_path)
    except (ValueError, TypeError, KeyError) as e:
        log.warning("%s bad input (%s/%s): %s", label, job_id, node_id, e)
        return error_response(str(e), 400)
    except Exception as e:  # noqa: BLE001
        log.error("%s failed (%s/%s)", label, job_id, node_id, exc_info=e)
        return error_response(f"{type(e).__name__}: {e}", 500)
    return jsonify(out)


@bp.route("/resolve", methods=["POST"])
@json_body
def resolve_route(b):
    """Resolve one value node's 0..1 curve for the segment+graph (the Scope card's live
    view) -> {curve, times, fps}. No render, no DB — just runs the value resolver, so a
    dangling `lfo -> scope` works with no output wired. An optional `fps` (default 30,
    clamped 1..120) samples the curve on the caller's timeline — the montage card
    passes the PROJECT fps so its frame indices convert to the same seconds the render
    uses (a 30fps curve read as 24fps frames showed every time 25% late)."""
    try:
        fps = max(1, min(120, int(b.get("fps") or 30)))
    except (TypeError, ValueError):
        fps = 30
    return _resolve_endpoint(
        b, lambda *args: graphmod.resolve_node_curve(*args, fps=fps), "resolve"
    )


@bp.route("/resolve-points", methods=["POST"])
@json_body
def resolve_points_route(b):
    """Resolve one points node's positions for the card preview -> {points:[[x,y],…]}.
    No render, no DB — the points equivalent of /resolve, so points/pattern/animate/
    merge show a live scatter."""
    return _resolve_endpoint(b, graphmod.resolve_node_points, "resolve-points")


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
            frames, fps, _n = fluid.simulate(params, apply_bg=False)  # dye on black; no bg setting
            fluid.render_mp4(frames, fps, out)
        except (ValueError, KeyError, TypeError) as e:
            log.warning("fluid render bad params: %s", e)
            return error_response(str(e), 400)
        except Exception as e:  # noqa: BLE001
            log.error("fluid render failed", exc_info=e)
            return error_response(f"{type(e).__name__}: {e}", 500)
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
        return error_response("missing job_id, segment, or graph", 400)
    if _bad_job(job_id):
        return error_response("bad job id", 404)
    try:
        url = graphmod.render(job_id, segment, graph, stem_audio_path, output, output_id)
    except ValueError as e:
        log.warning("animate rejected graph (%s): %s", job_id, e)
        return error_response(str(e), 400)
    except Exception as e:  # noqa: BLE001
        log.error("animate failed (%s)", job_id, exc_info=e)
        return error_response(f"{type(e).__name__}: {e}", 500)
    return jsonify({"url": url})


@bp.post("/animate/stream")
@json_body
def animate_stream(body):
    """Start a progressive block render -> {render_id}.

    Renders the same clip as `/animate` but front-to-back in ~5s blocks on a
    background worker: poll `GET /animate/stream/<render_id>` for the growing preview
    and final URL, and `POST /animate/stream/<render_id>/cancel` to stop it (the UI
    cancels the previous render on every edit). Bad graph -> HTTP 400 up front."""
    job_id = body.get("job_id")
    graph = body.get("graph")
    segment = body.get("segment")
    output = body.get("output")
    output_id = body.get("output_id")
    if not job_id or graph is None or segment is None:
        return error_response("missing job_id, segment, or graph", 400)
    if _bad_job(job_id):
        return error_response("bad job id", 404)
    try:  # fail fast on an invalid graph instead of surfacing it as an async error
        graphmod.validate(graph, output_id)
    except ValueError as e:
        log.warning("animate/stream rejected graph (%s): %s", job_id, e)
        return error_response(str(e), 400)
    render_id = render_jobs.start(
        lambda on_progress, should_cancel: graphmod.render_stream(
            job_id,
            segment,
            graph,
            stem_audio_path,
            output,
            output_id,
            on_progress=on_progress,
            should_cancel=should_cancel,
        )
    )
    return jsonify({"render_id": render_id})


@bp.get("/animate/stream/<render_id>")
def animate_stream_status(render_id):
    """Poll a streaming render: {state, frames_done, total, preview_url, url, error}.
    `state` is running|done|cancelled|error; use `preview_url` while running and
    `url` once done."""
    st = render_jobs.get(render_id)
    if st is None:
        return error_response("unknown render", 404)
    return jsonify(st)


@bp.post("/animate/stream/<render_id>/cancel")
def animate_stream_cancel(render_id):
    """Stop a streaming render after its current block (idempotent; ok even if the
    render already finished or is unknown)."""
    render_jobs.cancel(render_id)
    return jsonify({"ok": True})
