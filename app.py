"""Demucs Studio — Flask backend.

Upload a song -> separate into stems with Demucs (on the Apple Silicon GPU via
MPS) -> render a mel spectrogram per stem with librosa -> serve everything to a
single-page UI.
"""

import json
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

import segment as seg
import signals as sig
import fluid
import db

# --------------------------------------------------------------------------- #
# Paths & config
# --------------------------------------------------------------------------- #
BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
SEPARATED_DIR = DATA_DIR / "separated"
SPECTRO_DIR = DATA_DIR / "spectrograms"
ANALYSIS_DIR = DATA_DIR / "analysis"
FLUID_DIR = DATA_DIR / "fluid"
for d in (UPLOAD_DIR, SEPARATED_DIR, SPECTRO_DIR, ANALYSIS_DIR, FLUID_DIR):
    d.mkdir(parents=True, exist_ok=True)

# Stems demucs produces, plus the synthetic "original" (the uploaded mix).
STEMS = ["original", "vocals", "drums", "bass", "other"]

# Per-stem mel-spectrogram colormap.
COLORMAPS = {
    "original": "plasma",
    "vocals": "YlOrRd",
    "drums": "Reds",
    "bass": "BuPu",
    "other": "YlGn",
}

# Apple Silicon GPU (M5) via PyTorch MPS, with CPU fallback.
DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"

# Spectrogram parameters.
N_MELS = 128
N_FFT = 2048
HOP_LENGTH = 512
FMIN = 20
BG_COLOR = "#0A0C10"

# Flask is a pure API. The UI is always the Vite dev server (:5173).
app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 200 * 1024 * 1024  # 200 MB upload cap

# Ensure the projects table exists. Don't hard-fail import if Postgres is down —
# the error surfaces clearly on the first request that needs the DB.
try:
    db.init_schema()
except Exception as e:  # noqa: BLE001
    print(f"WARNING: could not init the database ({e}). "
          f"Is Postgres up? `docker compose up -d db`")


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
    proc = subprocess.run(cmd, capture_output=True, text=True)
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
    return jsonify({"service": "demucs-studio api",
                    "ui": "http://localhost:5173 (npm run dev)"})


@app.route("/upload", methods=["POST"])
def upload():
    """Stage 1: take the audio (+ optional lyrics), separate stems with demucs
    and render the full per-stem spectrograms. Segmentation is a separate call
    (/segment) so the slow Whisper alignment doesn't block the stem display."""
    audio_upload = request.files.get("file")
    youtube_url = (request.form.get("youtube_url") or "").strip()
    if (not audio_upload or not audio_upload.filename) and not youtube_url:
        return jsonify({"error": "provide an audio file or a YouTube URL"}), 400

    job_id = uuid4().hex[:8]
    job_upload_dir = UPLOAD_DIR / job_id
    job_upload_dir.mkdir(parents=True, exist_ok=True)

    # Source the original audio: an uploaded file wins; otherwise download the
    # best available audio from the YouTube URL.
    if audio_upload and audio_upload.filename:
        ext = Path(audio_upload.filename).suffix or ".wav"
        input_path = job_upload_dir / f"original{ext}"
        audio_upload.save(str(input_path))
    else:
        try:
            input_path = download_youtube_audio(youtube_url, job_upload_dir)
        except RuntimeError as e:
            return jsonify({"error": "youtube download failed",
                            "detail": str(e)}), 502

    # Save lyrics: either a pasted text field or an uploaded .txt/.lrc file.
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

    # Run demucs on the GPU (MPS) -> data/separated/<job_id>/<model>/<song>/...
    job_out = SEPARATED_DIR / job_id
    job_out.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, PYTORCH_ENABLE_MPS_FALLBACK="1")
    cmd = [
        sys.executable, "-m", "demucs",
        "-d", DEVICE,
        "-o", str(job_out),
        str(input_path),
    ]
    proc = subprocess.run(cmd, env=env, capture_output=True, text=True)
    if proc.returncode != 0:
        return jsonify({
            "error": "demucs failed",
            "detail": (proc.stderr or proc.stdout)[-2000:],
        }), 500

    # Generate spectrograms for original + each stem.
    job_spectro = SPECTRO_DIR / job_id
    job_spectro.mkdir(parents=True, exist_ok=True)
    stems = {}
    duration = 0.0
    for stem in STEMS:
        src = stem_audio_path(job_id, stem)
        if src is None:
            return jsonify({"error": f"missing stem output: {stem}"}), 500
        sr, dur = make_spectrogram(src, job_spectro / f"{stem}.png", COLORMAPS[stem])
        if stem == "original":
            duration = dur
        stems[stem] = {
            "audio": f"/audio/{job_id}/{stem}",
            "spectrogram": f"/spectrogram/{job_id}/{stem}",
            "sr": sr,  # top of the spectrogram == sr / 2
        }

    # Title / source for the project list.
    if audio_upload and audio_upload.filename:
        source, title = audio_upload.filename, Path(audio_upload.filename).stem
    else:
        title_file = job_upload_dir / "yt_title.txt"
        source = youtube_url
        title = (title_file.read_text().strip()
                 if title_file.exists() else youtube_url)

    db.create_project(job_id, title=title, source=source, duration=duration,
                      fmin=FMIN, has_lyrics=has_lyrics, stems=stems)

    return jsonify({"job_id": job_id, "fmin": FMIN, "duration": duration,
                    "has_lyrics": has_lyrics, "title": title, "stems": stems})


@app.route("/segment", methods=["POST"])
def segment_route():
    """Stage 2: propose musical segments for an already-uploaded job, driven by
    lyrics (Whisper alignment) + vocal activity (from the demucs vocals stem)."""
    data = request.get_json(silent=True) or {}
    job_id = data.get("job_id")
    if not job_id:
        return jsonify({"error": "missing job_id"}), 400

    original = stem_audio_path(job_id, "original")
    vocals = stem_audio_path(job_id, "vocals")
    if original is None:
        return jsonify({"error": "unknown job_id"}), 404

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

    try:
        result = seg.propose_segments(str(original), stems, lyrics_text)
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": f"{type(e).__name__}: {e}"}), 500

    return jsonify(_finalize_proposal(job_id, result))


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
        "vocal_envelope": analysis.get("vocal_envelope", []),
        "envelope_times": analysis.get("envelope_times", []),
        "lyric_lines": analysis.get("lyric_lines", []),
    })


@app.route("/projects/<job_id>", methods=["PUT"])
def project_save(job_id: str):
    body = request.get_json(silent=True) or {}
    ok = db.save_segments(job_id, body.get("segments", []),
                          step=body.get("step"), title=body.get("title"))
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
        return jsonify({"error": f"{type(e).__name__}: {e}"}), 500
    return jsonify(out)


@app.route("/fluid", methods=["POST"])
def fluid_route():
    """Run the centered-source fluid sim for the given params, encode an mp4, and
    return its URL. Cached by a params hash so revisiting settings replays
    instantly (the UI loops the clip and re-runs on changes)."""
    params = request.get_json(silent=True) or {}
    h = fluid.params_hash(params)
    out = FLUID_DIR / f"{h}.mp4"
    if not out.exists():
        try:
            frames, fps, _n = fluid.simulate(params)
            fluid.render_mp4(frames, fps, out)
        except Exception as e:  # noqa: BLE001
            return jsonify({"error": f"{type(e).__name__}: {e}"}), 500
    return jsonify({"url": f"/fluid/{h}.mp4"})


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
        print("WARNING: ffmpeg not found on PATH; non-WAV inputs may fail.")
    host = os.environ.get("HOST", "127.0.0.1")  # 0.0.0.0 in a container
    port = int(os.environ.get("PORT", "5000"))
    debug = os.environ.get("FLASK_DEBUG", "1") == "1"
    print(f"Demucs Studio starting — device: {DEVICE}, http://{host}:{port}")
    app.run(host=host, port=port, debug=debug)
