"""Shared constants and tiny helpers: STFT geometry, limits, preview quality.

These live in one place because the spectrogram render (``app.py``), the
segmentation analysis (``segment.py``) and the signal extractor (``signals.py``)
must agree on the STFT geometry — the band-select overlay's frequency<->pixel
mapping only stays correct while ``N_FFT``/``HOP``/``FMIN`` match across all
three. Keep them here, import everywhere.
"""

from __future__ import annotations

import os

import numpy as np

# STFT geometry (shared by the spectrogram, the analysis and the extractor).
N_FFT = 2048
HOP = 512
N_MELS = 128
FMIN = 20  # mel-spectrogram floor (Hz); stored per project for pixel mapping

# ---- limits & preview quality ------------------------------------------------
# Declared here rather than beside their users because several of these were
# written twice and could drift apart silently: the upload cap in particular lived
# both as Flask's hard MAX_CONTENT_LENGTH and as the route's friendlier check, with
# only one of the two honouring the environment.

# Upload cap. 2 GB (was 200 MB): modern phone clips routinely exceed 200 MB, and a
# folder upload sends them one file per request. Flask rejects anything larger with
# a bare 413 BEFORE a route can explain itself, so both limits must agree.
ASSET_MAX_BYTES = int(os.environ.get("ASSET_MAX_BYTES", str(2 * 1024**3)))

# Finished job records kept in memory before the oldest are pruned (ingestion and
# render pools each keep their own map, same policy).
MAX_JOB_RECORDS = 64

# Card previews never show the source file (a phone clip is ~1 GB of 4K): the
# backend derives a poster frame, a 360p proxy for scrubbing, and short excerpts.
PREVIEW_HEIGHT = 360
PREVIEW_THUMB_WIDTH = 240
PREVIEW_EXCERPT_SECONDS = 8  # mirrored in frontend/src/lib/assetPreview.ts

# ffmpeg wall-clock ceilings (seconds) for those derived files.
# How many derived-media transcodes may run at once (proxy / clip excerpt / thumb).
# Each ffmpeg happily eats every core, and these run ALONGSIDE the segment renders —
# uncapped, one editor tab starved the backend for half a minute.
FFMPEG_SLOTS = int(os.environ.get("FFMPEG_SLOTS", "2"))

PROXY_TIMEOUT = 900  # a 4K phone clip transcodes in ~40s; this is the pathological case
CLIP_TIMEOUT = 180
THUMB_TIMEOUT = 30


def normalise(x: np.ndarray) -> np.ndarray:
    """Peak-normalise to 0..1; all-zero (or near-zero) input -> zeros.

    Accepts lists or int arrays (cast to float64), so it's a drop-in for the
    extractor and the analysis code alike.
    """
    x = np.asarray(x, dtype=np.float64)
    peak = float(np.max(x)) if x.size else 0.0
    return x / peak if peak > 1e-12 else np.zeros_like(x)
