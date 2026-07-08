"""Media-serving routes: the API index, fluid clips, stem audio, and spectrogram
images. All static-ish reads off disk (range-served where <audio>/<video> seek).

Named `serving` (not `media`) so it doesn't clash with `backend/media.py`, the
audio/spectrogram helper module it imports from."""

from flask import Blueprint, abort, jsonify, send_file

from .. import fonts
from ..media import serve_range, stem_audio_path
from ..web import validate_asset_id, validate_job_id
from ..paths import ASSETS_DIR, ASSET_MIME, FLUID_DIR, SPECTRO_DIR, STEMS

bp = Blueprint("media", __name__)


@bp.route("/")
def index():
    # Pure API: the UI is the Vite dev server on :5173.
    return jsonify({"service": "kaika api", "ui": "http://localhost:5173 (npm run dev)"})


@bp.route("/fonts")
def fonts_list():
    # The bundled lyric fonts [{key, label}] for the lyrics card's font picker.
    return jsonify(fonts.list_fonts())


@bp.route("/fonts/<key>")
def font_file(key: str):
    # The TTF for one bundled font, so the browser can load it (@font-face) and draw a
    # live text preview on the lyrics card in the chosen typeface.
    path = fonts.font_path(key)
    if not path:
        abort(404)
    return send_file(path, mimetype="font/ttf")


@bp.route("/fluid/<name>")
def fluid_file(name: str):
    if not name.endswith(".mp4"):
        abort(404)
    p = FLUID_DIR / name
    if not p.exists():
        abort(404)
    return serve_range(p, mimetype="video/mp4")


@bp.route("/fluid/stream/<render_id>/<name>")
def fluid_stream_file(render_id: str, name: str):
    """A streaming render's growing preview chunk (data/fluid/stream/<id>/<name>).
    `render_id` is an output hash (hex); reject anything with path separators."""
    if not name.endswith(".mp4") or not render_id.isalnum():
        abort(404)
    p = FLUID_DIR / "stream" / render_id / name
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


_ASSET_MIME = ASSET_MIME  # shared ext -> mimetype table (paths.py)


@bp.route("/assets/<job_id>/<name>")
def asset_file(job_id: str, name: str):
    """A user-uploaded image/video layer asset (data/assets/<job_id>/<sha>.<ext>).
    Video is range-served so `<video>` can seek; images are sent whole."""
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if not validate_job_id(job_id) or ext not in _ASSET_MIME or not validate_asset_id(name.split(".")[0]):
        abort(404)
    p = ASSETS_DIR / job_id / name
    if not p.exists():
        abort(404)
    mimetype = _ASSET_MIME[ext]
    return serve_range(p, mimetype=mimetype) if mimetype.startswith("video/") else send_file(str(p), mimetype=mimetype)


@bp.route("/spectrogram/<job_id>/<stem>")
def spectrogram(job_id: str, stem: str):
    if not validate_job_id(job_id) or stem not in STEMS:
        abort(404)
    png = SPECTRO_DIR / job_id / f"{stem}.png"
    if not png.exists():
        abort(404)
    return send_file(str(png), mimetype="image/png")
