"""Final-export route: render the whole song as one continuous HD video.

Loads the project's segments/graphs/output/export settings + lyric lines from the DB
(so the client sends only a job_id), then streams `song_render.render_song` as a
background job — same poll/cancel contract as `/animate/stream`.
"""

from __future__ import annotations
import hashlib
import json
import logging
import threading
import time
from pathlib import Path

from flask import Blueprint, jsonify

from .. import db
from .. import graph as graphmod
from .. import render_cache
from .. import render_jobs
from .. import song_render
from ..media import stem_audio_path
from ..paths import ANALYSIS_DIR, ANIM_DIR, ASSETS_DIR
from ..web import json_body, error_response, validate_job_id

log = logging.getLogger("kaika")

bp = Blueprint("export", __name__)

# The HD defaults live in `song_render` so this blueprint, the segment route and
# `cache_gc` all read ONE definition (they are `_export_hash` inputs).
_EXPORT_DEFAULTS = song_render.EXPORT_DEFAULTS

# Serialises the read-modify-write of the analysis cache in `_record_export` — a
# whole-song and a segment export can now finish at the same time.
_RECORD_LOCK = threading.Lock()

# ONE HD render at a time (whole-song or single segment). Both are minutes long at a
# fine grid and share the `render_jobs` pool with every card preview; admission is
# non-blocking AT THE REQUEST (-> 409) rather than a wait inside the job, because a
# blocked job would sit on a pool worker and starve the previews it competes with.
_HD_SLOT = threading.BoundedSemaphore(1)
_HD_RUNNING: str | None = None

# How many single-segment HD renders a project pins against the cache sweep. Roughly
# "the last few HD checks of a session"; older ones age out like any unreferenced clip.
_SEGMENT_KEEP = 10


def _start_hd_render(run):
    """Admit ONE HD render: take the shared slot, start the job, remember its id.

    Returns `(response, status)` on refusal, or `(None, render_id)` on success. Written
    twice before (song + segment), including the `except: release; raise` that hands the
    slot back — miss that once and the first failed export 409s every later one for the
    life of the process, with a render_id that finished long ago and nothing in the UI to
    explain it.
    """
    global _HD_RUNNING
    if not _HD_SLOT.acquire(blocking=False):
        return (
            jsonify({"error": "an HD render is already running", "render_id": _HD_RUNNING}),
            409,
        ), None
    try:
        render_id = render_jobs.start(run)
    except Exception:
        _HD_SLOT.release()
        raise
    _HD_RUNNING = render_id
    return None, render_id


def _finish_hd_render() -> None:
    """Release the slot and forget the running id. Pairs with `_start_hd_render`; both
    job bodies call it from a `finally`."""
    global _HD_RUNNING
    _HD_RUNNING = None
    _HD_SLOT.release()


def _cached_lyric_lines(job_id: str) -> list:
    """A project's aligned lyric lines from the analysis cache.

    Delegates to `cache_gc._lyric_lines`, which is the copy that HANDLES a corrupt file.
    The two inline copies here did not: an unreadable analysis JSON 500'd the export
    route while the GC sweep shrugged it off. Same data, same read, one behaviour.
    """
    from ..cache_gc import _lyric_lines

    return _lyric_lines(job_id)


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
    lyric_lines = _cached_lyric_lines(job_id)

    if not segments:
        return error_response("project has no segments", 400)
    missing = [s.get("id") for s in segments if not s.get("finalOutputId")]
    if missing:
        return error_response(f"mark a final output for every segment (missing: {missing})", 400)

    # Shares the single HD slot with /export/segment — two fine-grid renders at once
    # would just starve each other (and every card preview) on the same worker pool.
    refused, render_id = _start_hd_render(
        lambda on_progress, should_cancel: _export_job(
            job_id, segments, lyric_lines, export, on_progress, should_cancel
        )
    )
    return refused or jsonify({"render_id": render_id})


def _segment_request(body):
    """Parse the shared body of the two segment-HD routes -> (error, ctx).

    Both the render and the cache lookup must agree on EVERY input that feeds
    `output_hash` — job, output card, the segment (lyric lines included) and the HD
    settings. Parsing it once is what keeps the lookup honest: a lookup that computed
    the key even slightly differently would answer "already exported" about a file
    rendered from something else, which is worse than no lookup at all."""
    job_id = body.get("job_id")
    if not validate_job_id(job_id):
        return error_response("bad job id", 404), None
    seg = body.get("segment")
    if not isinstance(seg, dict):
        return error_response("missing segment", 400), None
    graph = body.get("graph") or seg.get("graph")
    if not isinstance(graph, dict) or not graph.get("nodes"):
        return error_response("missing graph", 400), None
    row = db.get_project(job_id)
    if row is None:
        return error_response("unknown project", 404), None
    data = row.get("data") or {}
    export = {**_EXPORT_DEFAULTS, **(data.get("export") or {})}

    # Which output card to render: what was clicked, else the segment's marked final,
    # else the only output in the graph — otherwise it's genuinely ambiguous.
    outs = [n.get("id") for n in graph.get("nodes", []) if n.get("type") == "output"]
    output_id = body.get("output_id") or seg.get("finalOutputId")
    if output_id not in outs:
        if len(outs) != 1:
            return (
                error_response(
                    f"pick which output to render in HD (found {len(outs)}: {outs})", 400
                ),
                None,
            )
        output_id = outs[0]
    try:
        graphmod.validate(graph, output_id)
    except ValueError as e:
        return error_response(str(e), 400), None

    lyric_lines = _cached_lyric_lines(job_id)
    seg = {**seg, "graph": graph, "lyric_lines": seg.get("lyric_lines") or lyric_lines}
    return None, (job_id, seg, graph, output_id, export)


def _hd_output(export: dict) -> dict:
    """The render settings ONE segment's HD pass uses. Folded into `output_hash`, so
    this must be the single definition — the lookup route and the render read it here."""
    return {
        **song_render.output_from_export(export),
        # A sim-free graph must render at the export's NATIVE size, not on a
        # simulation grid — see graph_render._NATIVE_SHORT.
        "nativeShort": min(int(export.get("width") or 1080), int(export.get("height") or 1920)),
    }


def _hd_paths(job_id, seg, graph, output_id, export):
    """`(silent, muxed)` cache paths for this exact HD render. `silent` is the shared
    render-cache entry (`render_stream` returns it on a hit); `muxed` is the sibling
    carrying the audio — what the viewer actually plays."""
    h = graphmod.output_hash(job_id, seg, graph, output_id, _hd_output(export))
    silent = ANIM_DIR / f"{h}.mp4"
    muxed = ANIM_DIR / f"hd-{h}-{str(export.get('audioMode', 'original'))[:4]}.mp4"
    return silent, muxed


@bp.post("/export/segment/cached")
@json_body
def export_segment_cached(body):
    """Has THIS segment already been exported in HD? -> {url} or {url: null}.

    Stateless on purpose: the answer is `output_hash` over what the client is looking
    at, checked against the render cache right now. Nothing new is stored, so there is
    no fourth place to keep in sync and no entry can outlive the file it names — edit a
    card and the key moves, so the answer becomes "no" without a rule written for it.

    Lets a reloaded editor show a finished export instead of launching a new one: the
    in-memory job registry is gone after a reload, but the FILE is still on disk.

    Caveat: `_regenerate_hd_images` swaps imagegen/stylize assetUrls in memory, so a
    segment carrying those hashes differently here than it did while exporting — the
    answer is a miss and you re-export. Wrong-negative by design; never a false hit."""
    err, ctx = _segment_request(body)
    if err:
        return err
    silent, muxed = _hd_paths(*ctx)
    for path in (muxed, silent):  # prefer the one with audio
        if path.exists():
            render_cache.touch(path)  # a reused export must not age out
            return jsonify({"url": f"/fluid/{path.name}", "audio": path is muxed})
    return jsonify({"url": None})


@bp.post("/export/segment")
@json_body
def export_segment(body):
    """Start an HD render of ONE segment -> {render_id}. Poll/cancel through the SAME
    `/export/stream/<id>` endpoints as the whole-song export (they're generic over
    `render_jobs`). 409 when an HD render is already running.

    The segment + graph come from the CLIENT (autosave is debounced, so the DB copy can
    lag what the user is looking at — this must render exactly what's on screen); the HD
    settings come from the project's saved `export` block, so a segment preview and the
    final master can never disagree about size/fps/grid/audio."""
    err, ctx = _segment_request(body)
    if err:
        return err
    job_id, seg, graph, output_id, export = ctx
    hd_stylize = bool(body.get("hdStylize", True))

    refused, render_id = _start_hd_render(
        lambda on_progress, should_cancel: _segment_hd_job(
            job_id, seg, graph, output_id, export, hd_stylize, on_progress, should_cancel
        )
    )
    return refused or jsonify({"render_id": render_id})


# Frames-in-flight guard: a block holds `block_seconds * fps` frames at the FULL output
# size (1080x1920x30fps ≈ 8 MB/frame → a 5 s block is over a gigabyte). Scale the block
# down with the pixel count, floored so short segments still stream. Also tightens
# cancellation latency, which is only checked between blocks.
def _hd_block_seconds(w: int, h: int) -> float:
    ref = 540 * 960
    return max(0.5, min(5.0, 5.0 * ref / max(1, w * h)))


def _segment_hd_job(job_id, seg, graph, output_id, export, hd_stylize, on_progress, should_cancel):
    """One segment, rendered at the final export's settings, with its audio slice muxed
    in. Phases: HD assets -> render -> audio (published so the UI doesn't sit at 0%
    through minutes of regeneration)."""
    try:
        on_progress(phase="assets")
        _regenerate_hd_images(job_id, [seg], export, should_cancel)
        if should_cancel and should_cancel():
            return None
        output = _hd_output(export)  # shared with /export/segment/cached
        if hd_stylize:
            _regenerate_hd_stylize(job_id, [seg], export, should_cancel, output)
            if should_cancel and should_cancel():
                return None

        def progress(done, total, preview_url=None):
            on_progress(done, total, preview_url, phase="render")

        url = graphmod.render_stream(
            job_id,
            seg,
            graph,
            stem_audio_path,
            output,
            output_id,
            on_progress=progress,
            should_cancel=should_cancel,
            block_seconds=_hd_block_seconds(output["width"], output["height"]),
        )
        if not url:
            return None  # cancelled mid-render
        # The silent clip IS the shared render-cache entry for this hash — never mux
        # over it. The muxed sibling is what the viewer plays and what downloads.
        silent = ANIM_DIR / url.rsplit("/", 1)[-1]
        _record_export(job_id, url, key="segment_exports", keep=_SEGMENT_KEEP)
        audio = song_render.export_audio_path(job_id, export, stem_audio_path)
        if audio is None:
            return url  # no audio available — the silent clip is the result
        _, muxed = _hd_paths(job_id, seg, graph, output_id, export)
        muxed_url = f"/fluid/{muxed.name}"
        if not muxed.exists():
            on_progress(phase="audio")
            start = float(seg.get("start", 0.0))
            song_render._mux_audio(
                silent,
                audio,
                muxed,
                start=start,
                duration=max(0.0, float(seg.get("end", 0.0)) - start),
            )
        render_cache.touch(muxed)
        _record_export(job_id, muxed_url, key="segment_exports", keep=_SEGMENT_KEEP)
        return muxed_url
    finally:
        _finish_hd_render()


def _export_job(job_id, segments, lyric_lines, export, on_progress, should_cancel):
    """The background export: FIRST regenerate every Image-gen card's images fresh in
    HD (swapping their draft assetUrls in the in-memory graph), THEN render the song.
    Regeneration is slow (Z-Image is minutes/image), so it honours cancellation."""
    try:
        on_progress(phase="assets")
        _regenerate_hd_images(job_id, segments, export, should_cancel)
        if should_cancel and should_cancel():
            return None
        _regenerate_hd_stylize(job_id, segments, export, should_cancel)
        if should_cancel and should_cancel():
            return None

        def progress(done, total, preview_url=None):
            on_progress(done, total, preview_url, phase="render")

        # Which segment is being rendered, published WITHOUT frame numbers: song progress
        # only lands once per segment, so the counter sits still for minutes and this is
        # what keeps the UI honest meanwhile. The HD-segment job above has no equivalent —
        # it renders exactly one segment.
        def on_segment(i, n, label):
            on_progress(segment=f"{i}/{n}" + (f" · {label}" if label else ""))

        url = song_render.render_song(
            job_id,
            segments,
            lyric_lines,
            export,
            stem_audio_path,
            on_progress=progress,
            on_segment=on_segment,
            should_cancel=should_cancel,
        )
        if url:
            _record_export(job_id, url)
        return url
    finally:
        _finish_hd_render()


def _record_export(job_id: str, url: str, *, key: str = "song_exports", keep: int = 3) -> None:
    """Remember a finished export's cache stem in the analysis cache so `cache_gc`
    treats the mp4 as reachable. The stem can't always be recomputed from the saved
    project: the HD regeneration swaps imagegen/stylize assetUrls in MEMORY only (and a
    segment HD render uses the CLIENT's graph, which may not be saved at all), so the
    hash the export actually rendered under differs from a recompute over the saved
    urls. Best-effort — a failed record just means the file ages out like any
    unreferenced clip.

    `key` selects the list (`song_exports` / `segment_exports`) and `keep` bounds it, so
    a project can never pin an unbounded pile of masters. Locked: whole-song and segment
    exports can finish concurrently, and both read-modify-write the same json."""
    stem = url.rsplit("/", 1)[-1].removesuffix(".mp4")
    with _RECORD_LOCK:
        try:
            cache = ANALYSIS_DIR / f"{job_id}.json"
            analysis = json.loads(cache.read_text()) if cache.exists() else {}
            stems = [s for s in analysis.get(key, []) if s != stem]
            stems.append(stem)
            analysis[key] = stems[-keep:]  # the last few exports per project
            cache.write_text(json.dumps(analysis))
        except (OSError, ValueError) as e:
            log.warning("export: couldn't record %s stem for %s (%s)", key, job_id, e)


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
                    prompt,
                    seed=seed + i,
                    count=1,
                    model=imagegen.HD_MODEL,
                    aspect=aspect,
                    long_edge=long_edge,
                )[0]
                dest.parent.mkdir(parents=True, exist_ok=True)
                img.save(dest, format="PNG")
                db.add_asset(
                    job_id,
                    {
                        "id": f"hd-{key}",
                        "url": url,
                        "kind": "image",
                        "name": name,
                        "addedAt": int(time.time()),
                    },
                )
            urls.append(url)
        n["data"] = {**d, "assetUrls": urls}


def _regenerate_hd_stylize(job_id, segments, export, should_cancel, output=None):
    """For every `stylize` node, regenerate its clip in HD (Z-Image at a large short side)
    from the export-grid sim frames, and swap its `assetUrl` in place — so the export renders
    the HD version while the card keeps its fast draft. The expensive diffusion is content-
    keyed on the actual rendered input + settings, so an unchanged re-export reuses the clip.

    `output` is the render-engine dict the clip will actually be rendered under; the
    stylize INPUT frames must be simulated on that same grid or the diffusion runs on a
    different resolution than the render consuming it. Defaults to the export's own
    (they agree for the whole-song path — a segment render passes its `nativeShort` one)."""
    render_output = output or song_render.output_from_export(export)
    from .. import imagegen, fluid, graph as graphmod
    import tempfile
    import os

    short = int(export.get("stylizeSize") or 768)  # HD generation short side
    stylize_nodes = [
        (seg, n)
        for seg in segments
        for n in ((seg.get("graph") or {}).get("nodes") or [])
        if n.get("type") == "stylize"
    ]
    if not stylize_nodes:
        return
    log.info("export: regenerating %d stylize clip(s) in HD", len(stylize_nodes))
    for seg, n in stylize_nodes:
        if should_cancel and should_cancel():
            return
        graph = seg.get("graph") or {}
        d = n.get("data") or {}
        prompt = str(d.get("prompt") or "flowers")
        inpaint = bool(d.get("inpaint", False))
        try:
            frames, strength, fps, control = graphmod.stylize_source(
                job_id, seg, graph, n["id"], stem_audio_path, render_output
            )
        except ValueError as e:  # not wired to a video — leave it passing through
            log.warning("export: stylize %s skipped (%s)", n.get("id"), e)
            continue
        # content key from the actual rendered input + settings (the sim is cheap; the
        # diffusion is what we cache). Version marker: bump whenever generation semantics
        # change so stale clips regenerate (v2 = img2img anchor, v3 = control_scale 0.65).
        sample = frames[:: max(1, len(frames) // 8)].tobytes()
        key = hashlib.sha256(
            f"v3|{imagegen.HD_MODEL}|{short}|{prompt}|{inpaint}|{round(strength, 3)}|"
            f"{control is not None}".encode() + sample
        ).hexdigest()[:16]
        name = f"hd-stylize-{key}.mp4"
        dest = ASSETS_DIR / job_id / name
        url = f"/assets/{job_id}/{name}"
        if not dest.exists():
            log.info("export: HD stylize — %s", prompt[:48])
            styled = imagegen.stylize_frames(
                frames,
                prompt,
                strength=strength,
                inpaint=inpaint,
                model=imagegen.HD_MODEL,
                control=control,
                short=short,
            )
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = Path(tempfile.mkdtemp(prefix="hdstylize-")) / "c.mp4"
            fluid.render_mp4(styled, int(fps), tmp, out_w=styled.shape[2], out_h=styled.shape[1])
            dest.write_bytes(tmp.read_bytes())
            try:
                os.unlink(tmp)
                os.rmdir(tmp.parent)
            except OSError:
                pass
            db.add_asset(
                job_id,
                {
                    "id": f"hd-stylize-{key}",
                    "url": url,
                    "kind": "video",
                    "name": name,
                    "addedAt": int(time.time()),
                },
            )
        n["data"] = {**d, "assetUrl": url}


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
