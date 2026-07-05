"""Audio / spectrogram / range-serving helpers shared by the routes.

Extracted verbatim from app.py (spec 03) so the blueprints can import them without
a cycle back through the Flask app object. Signatures are unchanged.
"""

import re
import subprocess
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # headless: no GUI backend inside Flask
import matplotlib.pyplot as plt
import numpy as np
import librosa
import librosa.display
import torch
from flask import Response, abort, request, send_file

from . import segment as seg
from .config import N_FFT, HOP as HOP_LENGTH, N_MELS, FMIN
from .paths import (
    UPLOAD_DIR,
    SEPARATED_DIR,
    STEMS,
    BG_COLOR,
    YTDLP_TIMEOUT,
)

# Apple Silicon GPU (M5) via PyTorch MPS, with CPU fallback.
DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"


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
        mel_db,
        sr=sr,
        hop_length=HOP_LENGTH,
        x_axis=None,
        y_axis=None,
        fmin=FMIN,
        cmap=cmap,
        ax=ax,
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


def _ensure_instrumental(stem_dir: Path) -> Path | None:
    """The vocals-removed mix (drums+bass+other), built lazily next to the stems
    and cached as ``instrumental.wav``. The karaoke track for covers/rewritten
    lyrics: everything demucs separated except the vocal. `normalize=0` keeps
    amix from level-shifting the result (the stems already sum to the mix).
    Returns None if a source stem is missing or ffmpeg fails."""
    out = stem_dir / "instrumental.wav"
    if out.exists():
        return out
    parts = [stem_dir / f"{s}.wav" for s in ("drums", "bass", "other")]
    if not all(p.exists() for p in parts):
        return None
    cmd = ["ffmpeg", "-y", "-v", "error"]
    for p in parts:
        cmd += ["-i", str(p)]
    cmd += ["-filter_complex", "amix=inputs=3:normalize=0", str(out)]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0 or not out.exists():
        out.unlink(missing_ok=True)
        return None
    return out


def stem_audio_path(job_id: str, stem: str) -> Path | None:
    """Resolve the on-disk audio file for a given job/stem, or None.

    Besides the demucs stems and the uploaded ``original``, accepts the pseudo-stem
    ``instrumental`` — the lazily-mixed vocals-removed track (see
    `_ensure_instrumental`). One resolver serves both the export mux and the
    ``/audio/<job>/<stem>`` transport route."""
    if stem == "original":
        job_uploads = UPLOAD_DIR / job_id
        if not job_uploads.is_dir():
            return None
        # Only the uploaded audio (the lyrics file also lives in this dir).
        hits = sorted(job_uploads.glob("original.*"))
        return hits[0] if hits else None

    if stem != "instrumental" and stem not in STEMS:
        return None
    try:
        stem_dir = find_stem_dir(SEPARATED_DIR / job_id)
    except FileNotFoundError:
        return None
    if stem == "instrumental":
        return _ensure_instrumental(stem_dir)
    wav = stem_dir / f"{stem}.wav"
    return wav if wav.exists() else None


def _ytdlp_download(url: str, out_dir: Path, stem: str, fmt: str, extra: list, what: str) -> list:
    """Run yt-dlp with format `fmt` into ``out_dir/<stem>.<ext>`` and return the
    matching output files (sorted; .txt/.lrc sidecars excluded). `extra` appends
    download-specific flags; `what` names the output in error messages. Raises
    RuntimeError with yt-dlp's output on failure/timeout."""
    cmd = [
        sys.executable, "-m", "yt_dlp",
        "-f", fmt, "--no-playlist", *extra,
        "-o", str(out_dir / f"{stem}.%(ext)s"), url,
    ]  # fmt: skip
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=YTDLP_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"yt-dlp timed out after {YTDLP_TIMEOUT}s") from None
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout)[-2000:])
    hits = [p for p in sorted(out_dir.glob(f"{stem}.*")) if p.suffix.lower() not in (".txt", ".lrc")]
    if not hits:
        raise RuntimeError(f"yt-dlp finished but produced no {what} file")
    return hits


def download_youtube_audio(url: str, out_dir: Path) -> Path:
    """Download the best available audio of a YouTube URL into ``out_dir`` as
    ``original.<ext>`` (native container, no re-encode). Returns the path.

    Raises RuntimeError with yt-dlp's output on failure.
    """
    hits = _ytdlp_download(
        url, out_dir, "original",
        "bestaudio/best",  # best audio-only stream, else best overall
        ["--print-to-file", "%(title)s", str(out_dir / "yt_title.txt")],
        "audio",
    )
    return hits[0]


def download_youtube_video(url: str, out_dir: Path, stem: str = "ytvideo") -> Path:
    """Download the best video+audio of a YouTube URL into ``out_dir`` as
    ``<stem>.mp4`` (merged), returning the path. Used by the Video card's YouTube
    import (the pipeline-start YouTube stays audio-only). Raises RuntimeError on
    failure with yt-dlp's output."""
    hits = _ytdlp_download(
        url, out_dir, stem,
        "bv*+ba/b",  # best video+audio, else best single stream
        ["--merge-output-format", "mp4"],
        "video",
    )
    # Prefer the merged .mp4 if several intermediate files linger.
    return next((p for p in hits if p.suffix.lower() == ".mp4"), hits[0])


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

    def _stream(chunk_size: int = 64 * 1024):
        # Stream the range instead of buffering it whole — a big video seek would
        # otherwise pull the entire tail of the file into memory.
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(chunk_size, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    resp = Response(_stream(), status=206, mimetype=mimetype, direct_passthrough=True)
    resp.headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"
    resp.headers["Accept-Ranges"] = "bytes"
    resp.headers["Content-Length"] = str(length)
    return resp
