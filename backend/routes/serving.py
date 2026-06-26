"""Media-serving routes: the API index, fluid clips, stem audio, and spectrogram
images. All static-ish reads off disk (range-served where <audio>/<video> seek).

Named `serving` (not `media`) so it doesn't clash with `backend/media.py`, the
audio/spectrogram helper module it imports from."""

from flask import Blueprint, abort, jsonify, send_file

from ..media import serve_range, stem_audio_path
from ..web import validate_job_id
from ..paths import FLUID_DIR, SPECTRO_DIR, STEMS

bp = Blueprint("media", __name__)


@bp.route("/")
def index():
    # Pure API: the UI is the Vite dev server on :5173.
    return jsonify({"service": "kaika api", "ui": "http://localhost:5173 (npm run dev)"})


@bp.route("/fluid/<name>")
def fluid_file(name: str):
    if not name.endswith(".mp4"):
        abort(404)
    p = FLUID_DIR / name
    if not p.exists():
        abort(404)
    return serve_range(p, mimetype="video/mp4")


@bp.route("/audio/<job_id>/<stem>")
def audio(job_id: str, stem: str):
    if not validate_job_id(job_id):
        abort(404)
    path = stem_audio_path(job_id, stem)
    if path is None:
        abort(404)
    # Pick a sensible mimetype for the original (may be mp3/flac/etc.).
    ext = path.suffix.lower()
    mimetype = {
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".flac": "audio/flac",
        ".ogg": "audio/ogg",
        ".m4a": "audio/mp4",
    }.get(ext, "audio/wav")
    return serve_range(path, mimetype=mimetype)


@bp.route("/spectrogram/<job_id>/<stem>")
def spectrogram(job_id: str, stem: str):
    if not validate_job_id(job_id) or stem not in STEMS:
        abort(404)
    png = SPECTRO_DIR / job_id / f"{stem}.png"
    if not png.exists():
        abort(404)
    return send_file(str(png), mimetype="image/png")
