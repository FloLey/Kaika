"""Upload + segmentation routes and their background workers.

Stage 1 (`/upload`) and stage 2 (`/segment`) submit slow work to the job manager
and return a job id; the UI polls `/jobs/<id>` (and `/logs` for the backend feed).
"""

import json
import os
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

from flask import Blueprint, jsonify, request

from .. import segment as seg
from .. import jobs
from .. import db
from .. import logbus
from ..config import FMIN
from ..media import (
    stem_audio_path,
    lyrics_path,
    make_spectrogram,
    download_youtube_audio,
    DEVICE,
)
from ..paths import (
    UPLOAD_DIR,
    SEPARATED_DIR,
    SPECTRO_DIR,
    ANALYSIS_DIR,
    STEMS,
    COLORMAPS,
    DEMUCS_TIMEOUT,
)

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
    jobs.submit(
        job_id,
        first_step,
        lambda: _process_upload(
            job_id, input_path, youtube_url, job_upload_dir, has_lyrics, upload_filename
        ),
    )
    return jsonify({"job_id": job_id})


def _process_upload(job_id, input_path, youtube_url, job_upload_dir, has_lyrics, upload_filename):
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
    return {
        "job_id": job_id,
        "fmin": FMIN,
        "duration": duration,
        "has_lyrics": has_lyrics,
        "title": title,
        "stems": stems,
    }


@bp.route("/segment", methods=["POST"])
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
