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

# BG_COLOR is the paper the spectrogram sits on (matches the UI .spec well).
BG_COLOR = "#faf9f5"

# Subprocess wall-clock limits (seconds) so a hung download/separation can't
# wedge a worker forever. Generous by default; override via env for big files.
YTDLP_TIMEOUT = int(os.environ.get("YTDLP_TIMEOUT", "600"))
DEMUCS_TIMEOUT = int(os.environ.get("DEMUCS_TIMEOUT", "1800"))
