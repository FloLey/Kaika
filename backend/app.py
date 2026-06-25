"""Kaika — Flask backend.

Upload a song -> separate into stems with Demucs (on the Apple Silicon GPU via
MPS) -> render a mel spectrogram per stem with librosa -> serve everything to a
single-page UI.
"""

import json
import logging
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

import matplotlib

matplotlib.use("Agg")  # headless: no GUI backend inside Flask
import matplotlib.pyplot as plt
import numpy as np
import librosa
import librosa.display
import torch
from flask import Flask, Response, abort, jsonify, request, send_file
from werkzeug.exceptions import HTTPException

from . import segment as seg
from . import signals as sig
from . import fluid
from . import graph as graphmod
from . import render_cache
from . import db
from . import jobs
from . import logbus
from .config import N_FFT, HOP as HOP_LENGTH, N_MELS, FMIN

logbus.configure()
log = logging.getLogger("kaika")

# --------------------------------------------------------------------------- #
# Paths & config
# --------------------------------------------------------------------------- #
# Anchor data/ to the repo root (this file now lives in backend/, so go up one).
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
SEPARATED_DIR = DATA_DIR / "separated"
SPECTRO_DIR = DATA_DIR / "spectrograms"
ANALYSIS_DIR = DATA_DIR / "analysis"
FLUID_DIR = DATA_DIR / "fluid"
for d in (UPLOAD_DIR, SEPARATED_DIR, SPECTRO_DIR, ANALYSIS_DIR, FLUID_DIR):
    d.mkdir(parents=True, exist_ok=True)

# Stems demucs produces, plus the synthetic "original" (the uploaded mix).
STEMS = ["original", "vocals", "drums", "bass", "other"]

# Per-stem mel-spectrogram colormap, tuned for the light (paper) theme: each is a
# "white-low" sequential map, so quiet regions melt into the paper and energy
# blooms in the stem's hue (original = petal/RdPu, on-brand).
COLORMAPS = {
    "original": "RdPu",
    "vocals": "YlOrRd",
    "drums": "Reds",
    "bass": "BuPu",
    "other": "YlGn",
}

# Apple Silicon GPU (M5) via PyTorch MPS, with CPU fallback.
DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"

# Subprocess wall-clock limits (seconds) so a hung download/separation can't
# wedge a worker forever. Generous by default; override via env for big files.
YTDLP_TIMEOUT = int(os.environ.get("YTDLP_TIMEOUT", "600"))
DEMUCS_TIMEOUT = int(os.environ.get("DEMUCS_TIMEOUT", "1800"))

# Spectrogram parameters: N_MELS / N_FFT / HOP_LENGTH / FMIN come from config.py
# (shared with segment.py + signals.py so the band<->pixel mapping stays exact).
# BG_COLOR is the paper the spectrogram sits on (matches the UI .spec well).
BG_COLOR = "#faf9f5"

# Flask is a pure API. The UI is always the Vite dev server (:5173).
app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 200 * 1024 * 1024  # 200 MB upload cap

# Ensure the projects table exists. Don't hard-fail import if Postgres is down —
# the error surfaces clearly on the first request that needs the DB.
try:
    db.init_schema()
except db.DBUnavailable as e:
    log.warning("could not init the database (%s). Is Postgres up? "
                "`docker compose up -d db`", e)


# Every error path returns JSON (never Werkzeug's HTML page) so the frontend's
# jsonOrThrow always parses a `.error`, and unhandled failures land in the log
# stream with a traceback. The sync routes (/extract, /fluid, /animate) catch
# their own exceptions and return before reaching here.
@app.errorhandler(Exception)
def handle_unexpected(e):  # noqa: ANN001
    if isinstance(e, HTTPException):
        if e.code and e.code >= 500:
            log.error("HTTP %s on %s", e.code, request.path, exc_info=e)
        return jsonify({"error": e.name, "code": e.code}), e.code
    log.error("Unhandled exception on %s", request.path, exc_info=e)
    return jsonify({"error": f"{type(e).__name__}: {e}"}), 500


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def make_spectrogram(audio_path: Path, png_path: Path, cmap: str):
    """Render a dB-scaled mel spectrogram of ``audio_path`` to ``png_path``.

    Returns ``(sample_rate, duration_s)``: the frontend maps frequency <-> pixels
    (top of the image = ``sr / 2``) and time <-> pixels via the duration. The
    image is rendered full-bleed (axes fill the whole figure, no margins) so the
    playhead and frequency-band overlays align to pixels exactly.
    """
    y, sr = seg.load_audio(audio_path)
    mel = librosa.feature.melspectrogram(
        y=y, sr=sr, n_mels=N_MELS, n_fft=N_FFT, hop_length=HOP_LENGTH, fmin=FMIN
    )
    mel_db = librosa.power_to_db(mel, ref=np.max)

    fig, ax = plt.subplots(figsize=(14, 3), dpi=150)
    fig.patch.set_facecolor(BG_COLOR)
    ax.set_facecolor(BG_COLOR)
    librosa.display.specshow(
        mel_db, sr=sr, hop_length=HOP_LENGTH, x_axis=None, y_axis=None,
        fmin=FMIN, cmap=cmap, ax=ax,
    )
    ax.set_axis_off()
    ax.set_aspect("auto")
    ax.set_position([0, 0, 1, 1])  # axes fill the figure -> full-bleed image
    png_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(str(png_path), facecolor=BG_COLOR, pad_inches=0)
    plt.close(fig)
    return int(sr), float(len(y) / sr)


def find_stem_dir(job_out: Path) -> Path:
    """Locate ``<out>/<model>/<song>/`` produced by demucs without hardcoding it.

    Demucs writes ``<out>/<model_name>/<song_name>/<stem>.wav``. We discover the
    model and song directories dynamically so this keeps working with other
    models / --two-stems.
    """
    models = [p for p in job_out.iterdir() if p.is_dir()]
    if not models:
        raise FileNotFoundError(f"No demucs model output under {job_out}")
    model_dir = models[0]
    songs = [p for p in model_dir.iterdir() if p.is_dir()]
    if not songs:
        raise FileNotFoundError(f"No song output under {model_dir}")
    return songs[0]


def stem_audio_path(job_id: str, stem: str) -> Path | None:
    """Resolve the on-disk audio file for a given job/stem, or None."""
    if stem == "original":
        job_uploads = UPLOAD_DIR / job_id
        if not job_uploads.is_dir():
            return None
        # Only the uploaded audio (the lyrics file also lives in this dir).
        hits = sorted(job_uploads.glob("original.*"))
        return hits[0] if hits else None

    if stem not in STEMS:
        return None
    try:
        stem_dir = find_stem_dir(SEPARATED_DIR / job_id)
    except FileNotFoundError:
        return None
    wav = stem_dir / f"{stem}.wav"
    return wav if wav.exists() else None


def download_youtube_audio(url: str, out_dir: Path) -> Path:
    """Download the best available audio of a YouTube URL into ``out_dir`` as
    ``original.<ext>`` (native container, no re-encode). Returns the path.

    Raises RuntimeError with yt-dlp's output on failure.
    """
    out_tmpl = str(out_dir / "original.%(ext)s")
    cmd = [
        sys.executable, "-m", "yt_dlp",
        "-f", "bestaudio/best",     # best audio-only stream, else best overall
        "--no-playlist",
        "--print-to-file", "%(title)s", str(out_dir / "yt_title.txt"),
        "-o", out_tmpl,
        url,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=YTDLP_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"yt-dlp timed out after {YTDLP_TIMEOUT}s") from None
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout)[-2000:])
    hits = [p for p in sorted(out_dir.glob("original.*"))
            if p.suffix.lower() not in (".txt", ".lrc")]
    if not hits:
        raise RuntimeError("yt-dlp finished but produced no audio file")
    return hits[0]


def lyrics_path(job_id: str) -> Path | None:
    """The frozen lyrics file for a job (lyrics.txt / lyrics.lrc), if any."""
    job_uploads = UPLOAD_DIR / job_id
    if not job_uploads.is_dir():
        return None
    hits = sorted(job_uploads.glob("lyrics.*"))
    return hits[0] if hits else None


_RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")


def serve_range(path: Path, mimetype: str = "audio/wav") -> Response:
    """Serve ``path`` honoring an HTTP Range header (206) so <audio> can seek."""
    file_size = path.stat().st_size
    range_header = request.headers.get("Range")

    if not range_header:
        resp = send_file(str(path), mimetype=mimetype, conditional=True)
        resp.headers["Accept-Ranges"] = "bytes"
        return resp

    match = _RANGE_RE.match(range_header)
    if not match:
        abort(416)
    start_s, end_s = match.group(1), match.group(2)
    start = int(start_s) if start_s else 0
    end = int(end_s) if end_s else file_size - 1
    end = min(end, file_size - 1)
    if start > end or start >= file_size:
        resp = Response(status=416)
        resp.headers["Content-Range"] = f"bytes */{file_size}"
        return resp

    length = end - start + 1
    with open(path, "rb") as f:
        f.seek(start)
        chunk = f.read(length)

    resp = Response(chunk, status=206, mimetype=mimetype, direct_passthrough=True)
    resp.headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"
    resp.headers["Accept-Ranges"] = "bytes"
    resp.headers["Content-Length"] = str(length)
    return resp


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@app.route("/")
def index():
    # Pure API: the UI is the Vite dev server on :5173.
    return jsonify({"service": "kaika api",
                    "ui": "http://localhost:5173 (npm run dev)"})


@app.route("/upload", methods=["POST"])
def upload():
    """Stage 1: take the audio (+ optional lyrics), then run the slow work
    (yt-dlp download, demucs, spectrograms) in the background and return a job
    id immediately. The UI polls /jobs/<id>; the finished job's ``result`` is
    the stems payload. Segmentation is a separate call (/segment)."""
    audio_upload = request.files.get("file")
    youtube_url = (request.form.get("youtube_url") or "").strip()
    if (not audio_upload or not audio_upload.filename) and not youtube_url:
        return jsonify({"error": "provide an audio file or a YouTube URL"}), 400

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
    jobs.submit(job_id, first_step, lambda: _process_upload(
        job_id, input_path, youtube_url, job_upload_dir, has_lyrics, upload_filename))
    return jsonify({"job_id": job_id})


def _process_upload(job_id, input_path, youtube_url, job_upload_dir,
                    has_lyrics, upload_filename):
    """Background worker for /upload. Returns the stems payload; raises on any
    failure (the job manager turns that into the job's error)."""
    # 1. Source audio: uploaded file already on disk, else download it.
    if input_path is None:
        jobs.set_step(job_id, "downloading")
        input_path = download_youtube_audio(youtube_url, job_upload_dir)

    # 2. Separate stems with demucs (GPU/MPS) -> data/separated/<job_id>/...
    jobs.set_step(job_id, "separating")
    job_out = SEPARATED_DIR / job_id
    job_out.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, PYTORCH_ENABLE_MPS_FALLBACK="1")
    cmd = [sys.executable, "-m", "demucs", "-d", DEVICE, "-o", str(job_out), str(input_path)]
    try:
        proc = subprocess.run(cmd, env=env, capture_output=True, text=True,
                              timeout=DEMUCS_TIMEOUT)
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
        title = (title_file.read_text().strip()
                 if title_file.exists() else youtube_url)

    db.create_project(job_id, title=title, source=source, duration=duration,
                      fmin=FMIN, has_lyrics=has_lyrics, stems=stems)
    return {"job_id": job_id, "fmin": FMIN, "duration": duration,
            "has_lyrics": has_lyrics, "title": title, "stems": stems}


@app.route("/segment", methods=["POST"])
def segment_route():
    """Stage 2: propose musical segments for an already-uploaded job. The slow
    Whisper alignment + LLM labelling run in the background; the finished job's
    ``result`` is the segment proposal (segments + vocal envelope + lyrics)."""
    data = request.get_json(silent=True) or {}
    job_id = data.get("job_id")
    if not job_id:
        return jsonify({"error": "missing job_id"}), 400
    if stem_audio_path(job_id, "original") is None:
        return jsonify({"error": "unknown job_id"}), 404

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
        lyrics_text = ("\n".join(l.text for l in seg.parse_lrc(text))
                       if lyr.suffix == ".lrc" else text)

    result = seg.propose_segments(str(original), stems, lyrics_text)
    return _finalize_proposal(job_id, result)


@app.route("/jobs/<job_id>", methods=["GET"])
def job_status(job_id: str):
    """Poll a background job: {state: running|done|error, step, error, result}."""
    j = jobs.get(job_id)
    if j is None:
        return jsonify({"error": "unknown job"}), 404
    return jsonify(j)


@app.route("/logs", methods=["GET"])
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

    (ANALYSIS_DIR / f"{job_id}.json").write_text(json.dumps({
        "vocal_envelope": result.get("vocal_envelope", []),
        "envelope_times": result.get("envelope_times", []),
        "lyric_lines": result.get("lyric_lines", []),
    }))
    db.save_segments(job_id, result["segments"], step="review")
    return result


# --------------------------------------------------------------------------- #
# Projects (resumable state)
# --------------------------------------------------------------------------- #
@app.route("/projects", methods=["GET"])
def projects_list():
    return jsonify(db.list_projects())


@app.route("/projects/<job_id>", methods=["GET"])
def project_get(job_id: str):
    row = db.get_project(job_id)
    if row is None:
        abort(404)
    data = row.get("data") or {}
    # The expensive analysis (envelope + lyrics) lives in the filesystem cache so
    # re-opening the review screen doesn't re-run Whisper.
    analysis = {}
    cache = ANALYSIS_DIR / f"{job_id}.json"
    if cache.exists():
        analysis = json.loads(cache.read_text())
    return jsonify({
        "job_id": row["job_id"],
        "title": row["title"],
        "duration": row["duration"],
        "fmin": row["fmin"],
        "has_lyrics": row["has_lyrics"],
        "step": row["step"],
        "stems": data.get("stems", {}),
        "segments": data.get("segments", []),
        "output": data.get("output") or {},
        "vocal_envelope": analysis.get("vocal_envelope", []),
        "envelope_times": analysis.get("envelope_times", []),
        "lyric_lines": analysis.get("lyric_lines", []),
    })


@app.route("/projects/<job_id>", methods=["PUT"])
def project_save(job_id: str):
    body = request.get_json(silent=True) or {}
    ok = db.save_segments(job_id, body.get("segments", []),
                          step=body.get("step"), title=body.get("title"),
                          output=body.get("output"))
    if not ok:
        abort(404)
    return jsonify({"ok": True})


@app.route("/projects/<job_id>", methods=["DELETE"])
def project_delete(job_id: str):
    existed = db.delete_project(job_id)
    for d in (UPLOAD_DIR, SEPARATED_DIR, SPECTRO_DIR):
        shutil.rmtree(d / job_id, ignore_errors=True)
    (ANALYSIS_DIR / f"{job_id}.json").unlink(missing_ok=True)
    if not existed:
        abort(404)
    return jsonify({"ok": True})


@app.route("/extract", methods=["POST"])
def extract_route():
    """Extract one signal's curve: (stem + frequency band + segment window)
    shaped by attack/release/invert/gamma/gain/offset/threshold -> {curve,times}.
    The frontend calls this (debounced) as bands/sliders move."""
    b = request.get_json(silent=True) or {}
    if not isinstance(b, dict):
        return jsonify({"error": "body must be a JSON object"}), 400
    job_id = b.get("job_id")
    stem = b.get("stem", "original")
    src = stem_audio_path(job_id, stem) if job_id else None
    if src is None:
        return jsonify({"error": "unknown job/stem"}), 404
    try:
        out = sig.extract(
            str(src),
            float(b.get("start", 0.0)), float(b.get("end", 0.0)),
            float(b.get("minHz", 20.0)), float(b.get("maxHz", 20000.0)),
            feature=b.get("feature", "energy"),
            fps=int(b.get("fps", 30)),
            attack=float(b.get("attack", 5.0)),
            release=float(b.get("release", 250.0)),
            invert=bool(b.get("invert", False)),
            gamma=float(b.get("gamma", 1.0)),
            gain=float(b.get("gain", 1.0)),
            offset=float(b.get("offset", 0.0)),
            threshold=float(b.get("threshold", 0.0)),
        )
    except Exception as e:  # noqa: BLE001
        log.warning("extract failed (%s/%s): %s", job_id, stem, e)
        return jsonify({"error": f"{type(e).__name__}: {e}"}), 500
    return jsonify(out)


@app.route("/fluid", methods=["POST"])
def fluid_route():
    """Run the centered-source fluid sim for the given params, encode an mp4, and
    return its URL. Cached by a params hash so revisiting settings replays
    instantly (the UI loops the clip and re-runs on changes)."""
    params = request.get_json(silent=True) or {}
    if not isinstance(params, dict):
        return jsonify({"error": "body must be a JSON object"}), 400
    h = fluid.params_hash(params)
    out = FLUID_DIR / f"{h}.mp4"
    if out.exists():
        render_cache.touch(out)        # keep this hot clip from aging out (LRU)
    else:
        try:
            frames, fps, _n = fluid.simulate(params)
            fluid.render_mp4(frames, fps, out)
        except Exception as e:  # noqa: BLE001
            log.warning("fluid render failed: %s", e)
            return jsonify({"error": f"{type(e).__name__}: {e}"}), 500
        render_cache.evict(FLUID_DIR)  # bound the cache after adding a clip
    return jsonify({"url": f"/fluid/{h}.mp4"})


@app.post("/animate")
def animate():
    """Render a per-segment graph (`01`) to a cached, looping mp4 -> {url}.

    The request carries the live signal defs (`segment.signals`, Issue 1A) so the
    executor needs no DB read. Output is written under data/fluid/ and served by
    the existing `/fluid/<name>` route. Bad graph -> HTTP 400.
    """
    body = request.get_json(silent=True) or {}
    if not isinstance(body, dict):
        return jsonify({"error": "body must be a JSON object"}), 400
    job_id = body.get("job_id")
    graph = body.get("graph")
    segment = body.get("segment")  # { start, end, signals: [...] }
    output = body.get("output")    # project render settings (size/quality/fps/bg)
    output_id = body.get("output_id")  # which output's pipeline to render (N per graph)
    if not job_id or graph is None or segment is None:
        return jsonify({"error": "missing job_id, segment, or graph"}), 400
    try:
        url = graphmod.render(job_id, segment, graph, stem_audio_path, output, output_id)
    except ValueError as e:
        log.warning("animate rejected graph (%s): %s", job_id, e)
        return jsonify({"error": str(e)}), 400
    except Exception as e:  # noqa: BLE001
        log.warning("animate failed (%s): %s", job_id, e)
        return jsonify({"error": f"{type(e).__name__}: {e}"}), 500
    return jsonify({"url": url})


@app.route("/fluid/<name>")
def fluid_file(name: str):
    if not name.endswith(".mp4"):
        abort(404)
    p = FLUID_DIR / name
    if not p.exists():
        abort(404)
    return serve_range(p, mimetype="video/mp4")


@app.route("/audio/<job_id>/<stem>")
def audio(job_id: str, stem: str):
    path = stem_audio_path(job_id, stem)
    if path is None:
        abort(404)
    # Pick a sensible mimetype for the original (may be mp3/flac/etc.).
    ext = path.suffix.lower()
    mimetype = {
        ".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac",
        ".ogg": "audio/ogg", ".m4a": "audio/mp4",
    }.get(ext, "audio/wav")
    return serve_range(path, mimetype=mimetype)


@app.route("/spectrogram/<job_id>/<stem>")
def spectrogram(job_id: str, stem: str):
    if stem not in STEMS:
        abort(404)
    png = SPECTRO_DIR / job_id / f"{stem}.png"
    if not png.exists():
        abort(404)
    return send_file(str(png), mimetype="image/png")


if __name__ == "__main__":
    if not shutil.which("ffmpeg"):
        log.warning("ffmpeg not found on PATH; non-WAV inputs may fail.")
    host = os.environ.get("HOST", "127.0.0.1")  # 0.0.0.0 in a container
    port = int(os.environ.get("PORT", "5000"))
    debug = os.environ.get("FLASK_DEBUG", "1") == "1"
    log.info("Kaika starting — device: %s, http://%s:%s", DEVICE, host, port)
    # threaded so /jobs/<id> polling is served while a background job runs.
    # (In-memory jobs reset when the debug reloader restarts — fine for dev.)
    app.run(host=host, port=port, debug=debug, threaded=True)
