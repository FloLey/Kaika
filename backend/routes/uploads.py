"""Song ingestion: upload/YouTube -> Demucs -> spectrograms, then segmentation.

Both stages submit slow work to the job manager and return a job id; the UI polls
`/jobs/<id>` (routes/jobs_routes.py) and `/logs` for the backend feed. The asset library
that used to live here is routes/assets.py.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

from flask import Blueprint, jsonify, request

from .. import db
from .. import jobs
from .. import segment as seg
from ..config import FMIN
from ..media import (
    download_youtube_audio,
    lyrics_path,
    make_spectrogram,
    stem_audio_path,
    DEVICE,
)
from ..paths import (
    ASSET_EXTS,
    ANALYSIS_DIR,
    COLORMAPS,
    DEMUCS_TIMEOUT,
    SEPARATED_DIR,
    SPECTRO_DIR,
    STEMS,
    UPLOAD_DIR,
)
from ..web import json_body, validate_job_id, error_response
from .assets import _clip_bounds, _store_asset

log = logging.getLogger("kaika")

bp = Blueprint("uploads", __name__)


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
    if upload_filename and upload_filename.rsplit(".", 1)[-1].lower() in ASSET_EXTS["video"]:
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
