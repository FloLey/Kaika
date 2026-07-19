"""Upload + segmentation routes and their background workers.

Stage 1 (`/upload`) and stage 2 (`/segment`) submit slow work to the job manager
and return a job id; the UI polls `/jobs/<id>` (and `/logs` for the backend feed).
"""

import hashlib
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from uuid import uuid4

from flask import Blueprint, jsonify, request

from .. import segment as seg
from .. import jobs
from .. import db
from .. import logbus
from ..web import json_body, validate_asset_id, validate_job_id, error_response
from ..config import FMIN
from ..paths import ASSET_MIME, asset_file_for_url
from ..media import (
    serve_range,
    stem_audio_path,
    lyrics_path,
    make_spectrogram,
    download_youtube_audio,
    download_youtube_video,
    parse_timestamp,
    DEVICE,
)
from ..paths import (
    UPLOAD_DIR,
    SEPARATED_DIR,
    SPECTRO_DIR,
    ANALYSIS_DIR,
    ASSETS_DIR,
    ASSET_EXTS,
    STEMS,
    COLORMAPS,
    DEMUCS_TIMEOUT,
)

bp = Blueprint("uploads", __name__)

# Assets are content-addressed by hash so an identical re-upload dedupes and the
# reference is immutable. Allowed extensions live in paths.ASSET_EXTS (shared with
# the serving route's mimetype table).
_ASSET_EXTS = ASSET_EXTS
# 2 GB default (was 200 MB — phone videos blew past it); app.py MAX_CONTENT_LENGTH
# is the hard Flask ceiling this soft check must stay under.
_ASSET_MAX_BYTES = int(os.environ.get("ASSET_MAX_BYTES", str(2 * 1024**3)))


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
_PROXY_HEIGHT = 360
_THUMB_WIDTH = 240
_PROXY_TIMEOUT = 900  # a 4K phone clip transcodes in ~40s; this is the pathological case
_CLIP_TIMEOUT = 180
_THUMB_TIMEOUT = 30
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


@bp.route("/upload", methods=["POST"])
def upload():
    """Stage 1: take the audio (+ optional lyrics), then run the slow work
    (yt-dlp download, demucs, spectrograms) in the background and return a job
    id immediately. The UI polls /jobs/<id>; the finished job's ``result`` is
    the stems payload. Segmentation is a separate call (/segment)."""
    audio_upload = request.files.get("file")
    youtube_url = (request.form.get("youtube_url") or "").strip()
    if (not audio_upload or not audio_upload.filename) and not youtube_url:
        return error_response("provide an audio file or a YouTube URL", 400)
    yt_start = yt_end = None
    if youtube_url:  # optional clip bounds — validate NOW, not deep inside the job
        try:
            yt_start, yt_end = _clip_bounds(
                request.form.get("yt_start"), request.form.get("yt_end")
            )
        except RuntimeError as e:
            return error_response(str(e), 400)

    job_id = uuid4().hex[:8]
    job_upload_dir = UPLOAD_DIR / job_id
    job_upload_dir.mkdir(parents=True, exist_ok=True)

    # Anything that needs the request context happens now (file bytes, lyrics);
    # the slow work runs off-thread against what we've written to disk.
    input_path = None
    upload_filename = None
    if audio_upload and audio_upload.filename:
        upload_filename = audio_upload.filename
        ext = Path(audio_upload.filename).suffix or ".wav"
        input_path = job_upload_dir / f"original{ext}"
        audio_upload.save(str(input_path))

    has_lyrics = False
    lyrics_file = request.files.get("lyrics_file")
    lyrics_text = request.form.get("lyrics", "")
    if lyrics_file and lyrics_file.filename:
        l_ext = Path(lyrics_file.filename).suffix.lower()
        l_ext = l_ext if l_ext in (".lrc", ".txt") else ".txt"
        lyrics_file.save(str(job_upload_dir / f"lyrics{l_ext}"))
        has_lyrics = True
    elif lyrics_text.strip():
        (job_upload_dir / "lyrics.txt").write_text(lyrics_text)
        has_lyrics = True

    first_step = "separating" if input_path is not None else "downloading"
    jobs.submit(
        job_id,
        first_step,
        lambda: _process_upload(
            job_id,
            input_path,
            youtube_url,
            job_upload_dir,
            has_lyrics,
            upload_filename,
            yt_start,
            yt_end,
        ),
    )
    return jsonify({"job_id": job_id})


def _process_upload(
    job_id,
    input_path,
    youtube_url,
    job_upload_dir,
    has_lyrics,
    upload_filename,
    yt_start=None,
    yt_end=None,
):
    """Background worker for /upload. Returns the stems payload; raises on any
    failure (the job manager turns that into the job's error)."""
    # 1. Source audio: uploaded file already on disk, else download it.
    if input_path is None:
        jobs.set_step(job_id, "downloading")
        input_path = download_youtube_audio(youtube_url, job_upload_dir, start=yt_start, end=yt_end)

    # 1b. Uploaded a VIDEO? Split off its audio for the pipeline (the "original" stem
    # must be audio, resolved by globbing original.*) and keep the video itself as a
    # reusable project asset. Gate on the *uploaded* filename — a YouTube bestaudio
    # download is often a .webm (a "video" extension) but is audio-only, so it stays
    # on the normal path. The asset is registered AFTER create_project (add_asset needs
    # the row to exist); until then the file sits in ASSETS_DIR unlinked from the row.
    video_asset = None
    if upload_filename and upload_filename.rsplit(".", 1)[-1].lower() in _ASSET_EXTS["video"]:
        jobs.set_step(job_id, "extracting")
        wav_path = job_upload_dir / "original.wav"
        try:
            subprocess.run(
                ["ffmpeg", "-y", "-v", "error", "-i", str(input_path), "-vn", str(wav_path)],
                check=True,
                capture_output=True,
                text=True,
                timeout=DEMUCS_TIMEOUT,
            )
        except subprocess.TimeoutExpired:
            raise RuntimeError("audio extraction timed out") from None
        except subprocess.CalledProcessError as e:
            raise RuntimeError("audio extract failed: " + (e.stderr or "")[-1500:]) from None
        video_asset = _store_asset(
            job_id, input_path.read_bytes(), upload_filename, kind="video", register=False
        )
        input_path.unlink(missing_ok=True)  # so original.* globs the wav, not the video
        input_path = wav_path

    # 2. Separate stems with demucs (GPU/MPS) -> data/separated/<job_id>/...
    jobs.set_step(job_id, "separating")
    job_out = SEPARATED_DIR / job_id
    job_out.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, PYTORCH_ENABLE_MPS_FALLBACK="1")
    # DEMUCS_MODEL opts into a better separation (e.g. htdemucs_ft — the fine-tuned
    # model, ~4× slower to separate). Worth it when the instrumental matters: the
    # default model misclassifies more instrument content INTO the vocals stem,
    # which the karaoke mix then removes along with the voice.
    model = os.environ.get("DEMUCS_MODEL", "").strip()
    cmd = [sys.executable, "-m", "demucs", "-d", DEVICE,
           *(["-n", model] if model else []),
           "-o", str(job_out), str(input_path)]  # fmt: skip
    try:
        proc = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=DEMUCS_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"demucs separation exceeded {DEMUCS_TIMEOUT}s") from None
    if proc.returncode != 0:
        raise RuntimeError("demucs failed: " + (proc.stderr or proc.stdout)[-1500:])

    # 3. Render a spectrogram for the original + each stem.
    jobs.set_step(job_id, "rendering")
    job_spectro = SPECTRO_DIR / job_id
    job_spectro.mkdir(parents=True, exist_ok=True)
    stems = {}
    duration = 0.0
    for stem in STEMS:
        src = stem_audio_path(job_id, stem)
        if src is None:
            raise RuntimeError(f"missing stem output: {stem}")
        sr, dur = make_spectrogram(src, job_spectro / f"{stem}.png", COLORMAPS[stem])
        if stem == "original":
            duration = dur
        stems[stem] = {
            "audio": f"/audio/{job_id}/{stem}",
            "spectrogram": f"/spectrogram/{job_id}/{stem}",
            "sr": sr,  # top of the spectrogram == sr / 2
        }

    # 4. Title / source for the project list, then persist.
    if upload_filename:
        source, title = upload_filename, Path(upload_filename).stem
    else:
        title_file = job_upload_dir / "yt_title.txt"
        source = youtube_url
        title = title_file.read_text().strip() if title_file.exists() else youtube_url

    db.create_project(
        job_id,
        title=title,
        source=source,
        duration=duration,
        fmin=FMIN,
        has_lyrics=has_lyrics,
        stems=stems,
    )
    if video_asset is not None:  # now that the project row exists, add the source video
        db.add_asset(job_id, video_asset)
    return {
        "job_id": job_id,
        "fmin": FMIN,
        "duration": duration,
        "has_lyrics": has_lyrics,
        "title": title,
        "stems": stems,
    }


@bp.route("/segment", methods=["POST"])
@json_body
def segment_route(body):
    """Stage 2: propose musical segments for an already-uploaded job. The slow
    Whisper alignment + LLM labelling run in the background; the finished job's
    ``result`` is the segment proposal (segments + vocal envelope + lyrics)."""
    job_id = body.get("job_id")
    if not validate_job_id(job_id):
        return error_response("invalid job_id", 400)
    if stem_audio_path(job_id, "original") is None:
        return error_response("unknown job_id", 404)

    jobs.submit(job_id, "analysing", lambda: _process_segment(job_id))
    return jsonify({"job_id": job_id})


def _process_segment(job_id):
    """Background worker for /segment. Returns the finalized proposal."""
    original = stem_audio_path(job_id, "original")
    # All demucs stems feed the LLM's per-bar audio summary.
    stems = {}
    for k in ("vocals", "drums", "bass", "other"):
        p = stem_audio_path(job_id, k)
        if p is not None:
            stems[k] = str(p)

    lyr = lyrics_path(job_id)
    lyrics_text = None
    if lyr is not None:
        text = lyr.read_text(errors="replace")
        # .lrc carries [mm:ss] tags — reduce to plain lines for alignment.
        lyrics_text = (
            "\n".join(l.text for l in seg.parse_lrc(text)) if lyr.suffix == ".lrc" else text
        )

    result = seg.propose_segments(str(original), stems, lyrics_text)
    return _finalize_proposal(job_id, result)


@bp.route("/jobs/<job_id>", methods=["GET"])
def job_status(job_id: str):
    """Poll a background job: {state: running|done|error, step, error, result}."""
    j = jobs.get(job_id)
    if j is None:
        return jsonify({"error": "unknown job"}), 404
    return jsonify(j)


@bp.route("/logs", methods=["GET"])
def logs_route():
    """Incremental backend log feed for the frontend Logs panel.

    Returns {entries: [seq>since], seq: head}. MUST NOT log anything itself —
    otherwise each poll would create an entry the next poll fetches (runaway).
    """
    try:
        after = int(request.args.get("since", "0"))
    except (TypeError, ValueError):
        after = 0
    entries, seq = logbus.since(after)
    resp = jsonify({"entries": entries, "seq": seq})
    resp.headers["Cache-Control"] = "no-store"
    return resp


def _finalize_proposal(job_id: str, result: dict) -> dict:
    """Give each proposed segment a stable id + an empty tracks list (the
    frontend seeds the default stems), persist the baseline to Postgres, and
    cache the expensive analysis (envelope + lyrics) so resume is instant."""
    for i, s in enumerate(result["segments"]):
        s["id"] = f"seg-{i}"
        s.setdefault("signals", [])

    (ANALYSIS_DIR / f"{job_id}.json").write_text(
        json.dumps(
            {
                "vocal_envelope": result.get("vocal_envelope", []),
                "envelope_times": result.get("envelope_times", []),
                "lyric_lines": result.get("lyric_lines", []),
            }
        )
    )
    db.save_segments(job_id, result["segments"], step="review")
    return result
