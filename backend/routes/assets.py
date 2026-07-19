"""The per-project asset library, and the derived files a card preview needs.

An asset is content-addressed (`data/assets/<job>/<sha16>.<ext>`), so an identical
re-upload dedupes and a reference is immutable. Three companions are generated FROM a
video and live and die with it:

    <sha>-thumb.jpg          a poster frame — for anything that only SHOWS the clip
    <sha>-proxy.mp4          a 360p copy — the seekable source for scrubbing
    <sha>-clip-<t>-<d>.mp4   just the seconds a preview plays, cut on demand

They exist because a phone clip is routinely ~1 GB of 4K: several <video> elements
streaming originals at once stall the browser outright. The RENDER always reads the
original — these are display only.
"""

from __future__ import annotations

import hashlib
import logging
import os
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from uuid import uuid4

from flask import Blueprint, jsonify, request

from ..config import (
    ASSET_MAX_BYTES,
    CLIP_TIMEOUT,
    PREVIEW_HEIGHT,
    PREVIEW_THUMB_WIDTH,
    PROXY_TIMEOUT,
    THUMB_TIMEOUT,
)
from .. import db
from .. import jobs
from ..media import download_youtube_video, parse_timestamp, serve_range
from ..paths import ASSETS_DIR, ASSET_EXTS, ASSET_MIME, asset_file_for_url
from ..web import json_body, validate_asset_id, validate_job_id, error_response

bp = Blueprint("assets", __name__)

# Assets are content-addressed by hash so an identical re-upload dedupes and the
# reference is immutable. Allowed extensions live in paths.ASSET_EXTS (shared with
# the serving route's mimetype table).
_ASSET_EXTS = ASSET_EXTS
_ASSET_MAX_BYTES = ASSET_MAX_BYTES  # the same limit app.py gives Flask


# Preview PROXIES: `<sha>-proxy.mp4`, a 360p/no-audio copy of a video asset. Card
# previews play THIS, not the raw file — a phone clip is routinely 1 GB of 4K, which
# a 230px card can't use and which stalls (and visibly freezes) several <video>
# elements streaming at once. Generated lazily in the background: the route serves
# the raw file until the proxy lands, so nothing ever breaks, it just gets lighter.
_PROXY_SUFFIX = "-proxy.mp4"
# Companions generated FROM an asset — never mistaken for the original, and reaped
# with it (delete route + cache GC).
_THUMB_SUFFIX = "-thumb.jpg"
_DERIVED_SUFFIXES = (_THUMB_SUFFIX, _PROXY_SUFFIX)
# Excerpt cuts are `<sha>-clip-<start>-<dur>.mp4`; matched by prefix, not suffix.
_CLIP_INFIX = "-clip-"
_PROXY_HEIGHT = PREVIEW_HEIGHT
_THUMB_WIDTH = PREVIEW_THUMB_WIDTH
_PROXY_TIMEOUT = PROXY_TIMEOUT
_CLIP_TIMEOUT = CLIP_TIMEOUT
_THUMB_TIMEOUT = THUMB_TIMEOUT
_PROXY_SLOTS = threading.Semaphore(2)  # cap concurrent transcodes (they're CPU-heavy)
_proxy_pending: set[str] = set()
_proxy_lock = threading.Lock()


def _ffmpeg_atomic(args: list, dest: Path, timeout: int) -> bool:
    """Run ffmpeg writing to a temp file, then rename into `dest`. The three derived-file
    makers (thumb / proxy / clip excerpt) all need the same dance: a reader must never see
    a half-written file, and a failed run must leave nothing behind. `args` is everything
    between `ffmpeg` and the destination path."""
    tmp = dest.with_name(f"{dest.stem}.{os.getpid()}.{uuid4().hex[:8]}.tmp{dest.suffix}")
    try:
        proc = subprocess.run(
            ["ffmpeg", "-v", "error", "-y", *args, str(tmp)], capture_output=True, timeout=timeout
        )
    except (OSError, subprocess.TimeoutExpired):
        tmp.unlink(missing_ok=True)
        return False
    if proc.returncode == 0 and tmp.exists() and tmp.stat().st_size:
        os.replace(tmp, dest)
        return True
    tmp.unlink(missing_ok=True)
    return False


def _proxy_path(src: Path) -> Path:
    return src.with_name(src.stem + _PROXY_SUFFIX)


def _asset_base_file(job_id: str, asset_id: str):
    """The ORIGINAL file for an asset id (never one of its derived `-thumb`/`-proxy`
    companions), or None."""
    for p in (ASSETS_DIR / job_id).glob(f"{asset_id}.*"):
        if not p.name.endswith(_DERIVED_SUFFIXES) and _CLIP_INFIX not in p.name:
            return p
    return None


def _make_video_proxy(src: Path) -> bool:
    """Transcode `src` to its preview proxy (idempotent). Tries the Mac hardware
    encoder first, falls back to libx264. False if ffmpeg is unavailable/failed."""
    dest = _proxy_path(src)
    if dest.exists():
        return True
    scale = f"scale=-2:{_PROXY_HEIGHT}"
    for codec, rate in (("h264_videotoolbox", ["-b:v", "600k"]), ("libx264", ["-crf", "30"])):
        args = ["-i", str(src), "-vf", scale, "-c:v", codec, *rate, "-an",
                "-movflags", "+faststart"]  # fmt: skip
        if _ffmpeg_atomic(args, dest, _PROXY_TIMEOUT):
            return True
    return False


def _ensure_proxy_async(src: Path) -> None:
    """Kick a background proxy transcode for `src`, at most one per file."""
    key = str(src)
    with _proxy_lock:
        if key in _proxy_pending:
            return
        _proxy_pending.add(key)

    def run():
        try:
            with _PROXY_SLOTS:
                _make_video_proxy(src)
        finally:
            with _proxy_lock:
                _proxy_pending.discard(key)

    threading.Thread(target=run, daemon=True).start()


def _video_duration(path: Path) -> float:
    """Seconds, or 0.0 if ffprobe can't tell (a still, a broken file, no ffmpeg)."""
    from ..sources import _video_meta

    try:
        return float(_video_meta(str(path))[0] or 0.0)
    except Exception:  # noqa: BLE001 — metadata is a nicety, never a failed upload
        return 0.0


def _clip_name(asset_id: str, start: float, dur: float) -> str:
    return f"{asset_id}-clip-{start:.1f}-{dur:.1f}.mp4"


def _make_clip_excerpt(src: Path, dest: Path, start: float, dur: float) -> bool:
    """Cut `[start, start+dur]` out of `src` at preview height, into `dest`. Cheap: the
    source is normally the already-360p proxy, so this is a short re-encode of a few
    seconds. Atomic write — a reader never sees a partial file."""
    args = ["-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", str(src),
            "-vf", f"scale=-2:{_PROXY_HEIGHT}", "-c:v", "libx264", "-preset", "veryfast",
            "-crf", "30", "-an", "-movflags", "+faststart"]  # fmt: skip
    return _ffmpeg_atomic(args, dest, _CLIP_TIMEOUT)


@bp.get("/asset-clip/<job_id>/<asset_id>")
def asset_clip_route(job_id: str, asset_id: str):
    """Just the EXCERPT a card preview actually shows: `?start=&dur=` seconds of the
    clip, at preview height. A few hundred KB instead of a gigabyte — the card plays
    the real moving picture without the browser streaming (and re-streaming) the whole
    source. Cut once and cached on disk next to the asset; cuts come from the 360p
    proxy when it exists, else the original. Falls back to the proxy route's behaviour
    if ffmpeg can't produce the cut, so a preview never ends up blank."""
    if not validate_job_id(job_id) or not validate_asset_id(asset_id):
        return error_response("bad request", 400)
    src = _asset_base_file(job_id, asset_id)
    if src is None:
        return error_response("unknown asset", 404)
    try:
        start = max(0.0, float(request.args.get("start", 0.0)))
        dur = min(60.0, max(0.5, float(request.args.get("dur", 6.0))))
    except (TypeError, ValueError):
        start, dur = 0.0, 6.0
    dest = src.with_name(_clip_name(asset_id, start, dur))
    if not dest.exists():
        proxy = _proxy_path(src)
        if not _make_clip_excerpt(proxy if proxy.exists() else src, dest, start, dur):
            _ensure_proxy_async(src)  # cut failed — fall back to the whole preview copy
            whole = proxy if proxy.exists() else src
            return serve_range(whole, mimetype="video/mp4")
    return serve_range(dest, mimetype="video/mp4")


@bp.get("/asset-proxy/<job_id>/<asset_id>")
def asset_proxy_route(job_id: str, asset_id: str):
    """A video asset's lightweight preview copy, for the editor's card previews.

    Serves `<sha>-proxy.mp4` once it exists; until then it serves the ORIGINAL and
    kicks the transcode in the background — so a freshly added clip previews exactly
    like before (heavy but working) and every later view is ~100× lighter."""
    if not validate_job_id(job_id) or not validate_asset_id(asset_id):
        return error_response("bad request", 400)
    src = _asset_base_file(job_id, asset_id)
    if src is None:
        return error_response("unknown asset", 404)
    proxy = _proxy_path(src)
    if proxy.exists():
        return serve_range(proxy, mimetype="video/mp4")
    _ensure_proxy_async(src)
    return serve_range(src, mimetype=ASSET_MIME.get(src.suffix.lstrip(".").lower(), "video/mp4"))


def _sanitize_folder(raw: str) -> str:
    """A library asset's `folder`: a relative DISPLAY path ("May 2026/venise") the
    library groups by. Pure metadata — files stay content-addressed flat on disk, so
    this never touches path resolution; still, drop empty/"."/".." segments so the
    stored string can't even look like a traversal."""
    parts = [s.strip() for s in (raw or "").replace("\\", "/").split("/")]
    return "/".join(s for s in parts if s and s not in (".", ".."))[:512]


@bp.route("/upload-asset/<job_id>", methods=["POST"])
def upload_asset(job_id: str):
    """Store an image/video file for a project's layer cards and return its served URL.

    Lightweight + synchronous (no ingestion job): validate the extension, hash the
    bytes, save under `data/assets/<job_id>/<sha16>.<ext>`, and return
    `{url, kind, name}`. The Image/Video node stores `url` in its `data.assetUrl`.
    An optional `folder` form field (relative path, e.g. from a folder upload's
    webkitRelativePath) is kept as display metadata — the library groups by it."""
    if not validate_job_id(job_id):
        return error_response("bad job id", 404)
    f = request.files.get("file")
    if not f or not f.filename:
        return error_response("no file", 400)
    ext = f.filename.rsplit(".", 1)[-1].lower() if "." in f.filename else ""
    kind = next((k for k, exts in _ASSET_EXTS.items() if ext in exts), None)
    if kind is None:
        return error_response(f"unsupported file type '.{ext}'", 400)
    data = f.read()
    if not data:
        return error_response("empty file", 400)
    if len(data) > _ASSET_MAX_BYTES:
        return error_response(f"file too large (max {_ASSET_MAX_BYTES // 1024**2} MB)", 400)
    asset = _store_asset(
        job_id, data, f.filename, folder=_sanitize_folder(request.form.get("folder", ""))
    )
    return jsonify(asset)


# Server-side video thumbnails: `<sha>-thumb.jpg` next to the asset, shown by the
# library grid as a plain <img>. Dozens of live <video> elements froze the tab (each
# spawns a decoder, and Chrome renders phone clips it can't decode as black); ffmpeg
# decodes everything server-side once instead. The GC keeps a thumb alive with its
# base file; the delete route unlinks both. (`_THUMB_SUFFIX` is declared with the
# other derived-file suffixes at the top of the module.)
def _make_video_thumb(src: Path) -> bool:
    """Write `<stem>-thumb.jpg` (240px wide, grabbed ~0.3s in, falling back to frame
    0 for ultra-short clips) next to `src`. Idempotent; False on failure (the grid
    falls back to a 🎞 placeholder)."""
    dest = src.with_name(src.stem + _THUMB_SUFFIX)
    if dest.exists():
        return True
    for ss in ("0.3", "0"):  # ultra-short clips have no frame at 0.3s
        args = ["-ss", ss, "-i", str(src), "-frames:v", "1", "-vf", f"scale={_THUMB_WIDTH}:-2"]
        if _ffmpeg_atomic(args, dest, _THUMB_TIMEOUT):
            return True
    return False


# One backfill thread per job at a time: listing the library kicks a daemon that
# fills in thumbs for videos uploaded before thumbnails existed (idempotent — each
# existing thumb is skipped), so old libraries heal on first open.
_thumb_jobs: set[str] = set()
_thumb_lock = threading.Lock()


def _backfill_thumbs(job_id: str) -> None:
    try:
        for a in db.list_assets(job_id):
            if a.get("kind") != "video":
                continue
            p = asset_file_for_url(a.get("url"), ASSETS_DIR)
            if p is not None and p.exists():
                _make_video_thumb(p)
    except Exception as e:  # noqa: BLE001 — background nicety, never user-facing
        logging.getLogger("kaika").warning("thumb backfill failed (%s): %s", job_id, e)
    finally:
        with _thumb_lock:
            _thumb_jobs.discard(job_id)


def _store_asset(
    job_id: str,
    data: bytes,
    filename: str,
    kind: str | None = None,
    *,
    register: bool = True,
    folder: str = "",
) -> dict:
    """Content-address `data` into `data/assets/<job>/<sha>.<ext>`, register it in the
    project's `data.assets` library, and return the asset dict. `filename` supplies the
    extension + display name; `kind` may be forced (else inferred from the extension);
    `folder` (already sanitized) is display metadata the library groups by.

    `register=False` writes the file but skips `db.add_asset` — for the pipeline-start
    video, whose project row doesn't exist yet; the caller registers it post-create."""
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    kind = kind or next((k for k, exts in _ASSET_EXTS.items() if ext in exts), "image")
    sha = hashlib.sha256(data).hexdigest()[:16]
    ext = "jpg" if ext == "jpeg" else (ext or "mp4")
    dest_dir = ASSETS_DIR / job_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{sha}.{ext}"
    dest.write_bytes(data)
    if kind == "video":
        _make_video_thumb(dest)  # best-effort — the grid has a placeholder fallback
    asset = {
        "id": sha,
        "url": f"/assets/{job_id}/{sha}.{ext}",
        "kind": kind,
        "name": filename,
        "addedAt": int(time.time()),
    }
    if kind == "video":
        # The montage card needs each clip's duration to flag a slot its clip can't fill.
        # It used to measure that in the browser by opening the ORIGINAL file — a gigabyte
        # per card. ffprobe already told us here.
        duration = _video_duration(dest)
        if duration:
            asset["duration"] = round(duration, 3)
    if folder:
        asset["folder"] = folder
    if register:
        db.add_asset(job_id, asset)
    return asset


@bp.get("/assets/<job_id>")
def list_assets_route(job_id: str):
    """The project's asset library `[{id, url, kind, name, addedAt}]` (the file route is
    `/assets/<job>/<name>` — this one-segment path lists the library). Kicks a one-shot
    background backfill of missing video thumbnails for pre-thumbnail libraries."""
    if not validate_job_id(job_id):
        return error_response("bad job id", 404)
    with _thumb_lock:
        fresh = job_id not in _thumb_jobs
        if fresh:
            _thumb_jobs.add(job_id)
    if fresh:
        threading.Thread(target=_backfill_thumbs, args=(job_id,), daemon=True).start()
    return jsonify(db.list_assets(job_id))


@bp.delete("/assets/<job_id>/<asset_id>")
def delete_asset_route(job_id: str, asset_id: str):
    """Remove a library asset by id: unlink its file(s) and drop it from `data.assets`."""
    if not validate_job_id(job_id) or not validate_asset_id(asset_id):
        return error_response("bad request", 400)
    patterns = (
        f"{asset_id}.*",
        *(f"{asset_id}{sfx}" for sfx in _DERIVED_SUFFIXES),
        f"{asset_id}{_CLIP_INFIX}*",
    )
    for pattern in patterns:
        for p in (ASSETS_DIR / job_id).glob(pattern):
            try:
                p.unlink()
            except OSError:
                pass
    db.remove_asset(job_id, asset_id)
    return jsonify({"ok": True})


@bp.route("/asset-from-youtube/<job_id>", methods=["POST"])
@json_body
def asset_from_youtube(body, job_id):
    """Import a YouTube video as a project asset (video card action; the pipeline-start
    YouTube stays audio-only). Downloads video+audio off-thread, content-addresses it into
    the library, and returns a job id; the card polls /jobs/<id> for the asset result."""
    if not validate_job_id(job_id):
        return error_response("bad job id", 404)
    url = (body.get("url") or "").strip()
    if not url:
        return error_response("provide a YouTube URL", 400)
    try:  # optional clip bounds — validate NOW so the user gets a 400, not a dead job
        start, end = _clip_bounds(body.get("start"), body.get("end"))
    except RuntimeError as e:
        return error_response(str(e), 400)
    dl_job = uuid4().hex[:8]
    jobs.submit(dl_job, "downloading", lambda: _download_asset_video(job_id, url, start, end))
    return jsonify({"job_id": dl_job})


def _clip_bounds(start, end) -> tuple:
    """Optional user-typed clip bounds → (seconds|None, seconds|None). Raises
    RuntimeError (a 400-ready message) on garbage or an empty/negative range."""
    lo = parse_timestamp(start) if str(start or "").strip() else None
    hi = parse_timestamp(end) if str(end or "").strip() else None
    if hi is not None and hi <= (lo or 0.0):
        raise RuntimeError("end timestamp must be after start")
    return lo, hi


def _download_asset_video(job_id: str, url: str, start=None, end=None) -> dict:
    """Background worker: yt-dlp the video into a temp dir, store it as a library asset,
    clean up. Returns the asset dict (the job result the card consumes)."""
    tmp = Path(tempfile.mkdtemp(prefix=f"ytasset-{job_id}-"))
    try:
        video = download_youtube_video(url, tmp, start=start, end=end)
        return _store_asset(job_id, video.read_bytes(), video.name, kind="video")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
