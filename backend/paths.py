"""Shared data-directory tree + project constants.

A cycle-free home for the paths and constants the routes share. Imported by the
blueprints and the media helpers; imports nothing heavy itself (just stdlib), so
it's safe to pull in anywhere.
"""

import os
from pathlib import Path

# Anchor data/ to the repo root (this file lives in backend/, so go up one).
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
SEPARATED_DIR = DATA_DIR / "separated"
SPECTRO_DIR = DATA_DIR / "spectrograms"
ANALYSIS_DIR = DATA_DIR / "analysis"
FLUID_DIR = DATA_DIR / "fluid"
ASSETS_DIR = DATA_DIR / "assets"  # user-uploaded image/video layer assets, per job_id
# Rendered-clip cache + streaming scratch. ANIM_DIR is the same dir the `/fluid/<name>`
# route serves (FLUID_DIR) — the render side calls it ANIM_DIR. Consumers read these
# late-bound (`paths.ANIM_DIR`) so tests patch ONE place.
ANIM_DIR = FLUID_DIR
STREAM_DIR = FLUID_DIR / "stream"
# App-level settings (remote inference, …) — one JSON file, read late-bound
# (`paths.SETTINGS_FILE`) so tests patch it like the directories above.
SETTINGS_FILE = DATA_DIR / "settings.json"
# Job-state snapshot (backend/jobs.py): lets /jobs/<id> answer across the dev
# reloader's restarts instead of 404ing every in-flight generation.
JOBS_STATE_FILE = DATA_DIR / "jobs_state.json"
for d in (UPLOAD_DIR, SEPARATED_DIR, SPECTRO_DIR, ANALYSIS_DIR, FLUID_DIR, ASSETS_DIR):
    d.mkdir(parents=True, exist_ok=True)

# Image/video layer assets: kind -> allowed upload extensions, ext -> served mimetype.
# The single source for the upload validation (routes/uploads) and the file serving
# (routes/serving); an asset URL is always `/assets/<job_id>/<sha16>.<ext>`.
ASSET_EXTS = {
    "image": {"png", "jpg", "jpeg", "webp"},
    "video": {"mp4", "mov", "webm", "m4v"},
}
ASSET_MIME = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "webp": "image/webp",
    "mp4": "video/mp4",
    "mov": "video/quicktime",
    "webm": "video/webm",
    "m4v": "video/mp4",
}


def asset_file_for_url(url: str, assets_dir: Path | None = None):
    """`/assets/<job>/<name>` -> its on-disk path (no existence check), or None for
    anything else. `assets_dir` lets callers pass their (test-patchable) module copy."""
    parts = (url or "").strip("/").split("/")
    base = ASSETS_DIR if assets_dir is None else assets_dir
    return base / parts[1] / parts[2] if len(parts) == 3 and parts[0] == "assets" else None


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

# BG_COLOR is the paper the spectrogram sits on (matches the UI .spec well).
BG_COLOR = "#faf9f5"

# Subprocess wall-clock limits (seconds) so a hung download/separation can't
# wedge a worker forever. Generous by default; override via env for big files.
YTDLP_TIMEOUT = int(os.environ.get("YTDLP_TIMEOUT", "600"))
DEMUCS_TIMEOUT = int(os.environ.get("DEMUCS_TIMEOUT", "1800"))
