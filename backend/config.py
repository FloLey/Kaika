"""Shared audio/spectrogram constants and tiny helpers.

These live in one place because the spectrogram render (``app.py``), the
segmentation analysis (``segment.py``) and the signal extractor (``signals.py``)
must agree on the STFT geometry — the band-select overlay's frequency<->pixel
mapping only stays correct while ``N_FFT``/``HOP``/``FMIN`` match across all
three. Keep them here, import everywhere.
"""

from __future__ import annotations

import numpy as np

# STFT geometry (shared by the spectrogram, the analysis and the extractor).
N_FFT = 2048
HOP = 512
N_MELS = 128
FMIN = 20  # mel-spectrogram floor (Hz); stored per project for pixel mapping


def normalise(x: np.ndarray) -> np.ndarray:
    """Peak-normalise to 0..1; all-zero (or near-zero) input -> zeros.

    Accepts lists or int arrays (cast to float64), so it's a drop-in for the
    extractor and the analysis code alike.
    """
    x = np.asarray(x, dtype=np.float64)
    peak = float(np.max(x)) if x.size else 0.0
    return x / peak if peak > 1e-12 else np.zeros_like(x)
