"""Signal extraction: a (stem + frequency band + segment) -> a drawable curve.

The spectrogram is already an STFT; a *signal* takes the frequency rows of the
chosen band, collapses them to one number per frame (the band's energy over
time), then shapes that curve with an asymmetric envelope follower (attack /
release) plus threshold / gamma / invert / gain / offset. The result is a
normalized 0..1 curve, one value per frame at ``fps`` — what the user sees and
what later drives the in-project simulation.

``_RAW`` dispatches the feature (energy / onset / flux / brightness / harmonic /
chroma / beat / bar); every feature returns a per-frame 0..1 curve and goes
through the same :func:`shape` pipeline. Pure + model-free.
"""
from __future__ import annotations

import math
import os
from collections import OrderedDict
from pathlib import Path

import numpy as np
import librosa

import segment as seg
from config import N_FFT, normalise as _normalise

# These caches hold full-song STFTs / HPSS / beat grids (each large). Bound them
# so a session that processes many songs can't grow memory without limit — keep
# the most-recently-used few per cache.
_CACHE_CAP = int(os.environ.get("SIGNAL_CACHE_CAP", "4"))


class _LRU(OrderedDict):
    """Minimal LRU: ``get`` refreshes recency, ``put`` evicts the oldest."""

    def get(self, key, default=None):
        if key in self:
            self.move_to_end(key)
            return self[key]
        return default

    def put(self, key, val):
        self[key] = val
        self.move_to_end(key)
        while len(self) > _CACHE_CAP:
            self.popitem(last=False)


# STFT magnitude cached per (stem path, fps): band/segment/shaping changes then
# cost only a row-mask + sum, so dragging sliders stays snappy.
_STFT_CACHE: _LRU = _LRU()


def _stft(stem_path: str | Path, fps: int) -> tuple:
    key = (str(stem_path), int(fps))
    hit = _STFT_CACHE.get(key)
    if hit is not None:
        return hit
    y, sr = seg.load_audio(stem_path)
    hop = max(1, int(round(sr / fps)))
    S = np.abs(librosa.stft(y, n_fft=N_FFT, hop_length=hop))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=N_FFT)
    val = (S, sr, hop, freqs)
    _STFT_CACHE.put(key, val)
    return val


_EMPTY = (np.zeros(0), np.zeros(0))

# Heavier per-stem analyses, cached (and bounded) like the STFT.
_HPSS_CACHE: _LRU = _LRU()
_BEAT_CACHE: _LRU = _LRU()


def _window(stem_path: str | Path, fps: int, start: float, end: float):
    """(S, sr, hop, freqs, f0, f1, times) for the segment window [start,end]."""
    S, sr, hop, freqs = _stft(stem_path, fps)
    n = S.shape[1]
    f0 = max(0, int(round(start * sr / hop)))
    f1 = min(n, int(round(end * sr / hop)))
    times = np.arange(f0, f1) * hop / sr
    return S, sr, hop, freqs, f0, f1, times


def _band_rows(freqs: np.ndarray, min_hz: float, max_hz: float):
    """Boolean mask of FFT rows inside [min_hz, max_hz] (nearest row if empty)."""
    lo, hi = (min_hz, max_hz) if min_hz <= max_hz else (max_hz, min_hz)
    rows = (freqs >= lo) & (freqs <= hi)
    if not rows.any():
        rows = np.zeros(len(freqs), bool)
        rows[int(np.argmin(np.abs(freqs - lo)))] = True
    return rows, lo, hi


def _hpss(stem_path: str | Path, fps: int):
    key = (str(stem_path), int(fps))
    hit = _HPSS_CACHE.get(key)
    if hit is None:
        S, _sr, _hop, _f = _stft(stem_path, fps)
        hit = librosa.decompose.hpss(S)
        _HPSS_CACHE.put(key, hit)
    return hit


def _beats(stem_path: str | Path, fps: int):
    key = (str(stem_path), int(fps))
    hit = _BEAT_CACHE.get(key)
    if hit is None:
        y, sr = seg.load_audio(stem_path)
        hop = max(1, int(round(sr / fps)))
        tempo, frames = librosa.beat.beat_track(y=y, sr=sr, hop_length=hop)
        beat_times = librosa.frames_to_time(frames, sr=sr, hop_length=hop)
        hit = (float(np.atleast_1d(tempo)[0]), beat_times)
        _BEAT_CACHE.put(key, hit)
    return hit


# --------------------------------------------------------------------------- #
# Raw feature extractors: (stem, [start,end], band) -> per-frame 0..1 curve.
# --------------------------------------------------------------------------- #
def raw_energy(stem_path, start, end, min_hz, max_hz, fps=30):
    """Band loudness over time — the default driver."""
    S, sr, hop, freqs, f0, f1, times = _window(stem_path, fps, start, end)
    if f1 <= f0:
        return _EMPTY
    rows, _lo, _hi = _band_rows(freqs, min_hz, max_hz)
    return _normalise(S[rows, f0:f1].sum(axis=0)), times


def raw_flux(stem_path, start, end, min_hz, max_hz, fps=30):
    """Positive spectral flux of the band — how fast it's changing ("busy-ness")."""
    S, sr, hop, freqs, f0, f1, times = _window(stem_path, fps, start, end)
    if f1 <= f0:
        return _EMPTY
    rows, _lo, _hi = _band_rows(freqs, min_hz, max_hz)
    band = S[rows]
    d = np.maximum(np.diff(band, axis=1, prepend=band[:, :1]), 0).sum(axis=0)
    return _normalise(d[f0:f1]), times


def raw_onset(stem_path, start, end, min_hz, max_hz, fps=30):
    """Impulse (1.0) at each detected hit in the band, else 0 — the `release`
    knob turns each impulse into a decaying spike."""
    S, sr, hop, freqs, f0, f1, times = _window(stem_path, fps, start, end)
    if f1 <= f0:
        return _EMPTY
    rows, _lo, _hi = _band_rows(freqs, min_hz, max_hz)
    env = librosa.onset.onset_strength(
        S=librosa.amplitude_to_db(S[rows], ref=np.max), sr=sr, hop_length=hop)
    frames = librosa.onset.onset_detect(
        onset_envelope=env, sr=sr, hop_length=hop, backtrack=False)
    out = np.zeros(S.shape[1])
    sel = frames[(frames >= f0) & (frames < f1)]
    out[sel] = 1.0
    return out[f0:f1], times


def raw_brightness(stem_path, start, end, min_hz, max_hz, fps=30):
    """Spectral centroid within the band, mapped 0..1 across [min,max] — where the
    energy sits (low=dull, high=bright)."""
    S, sr, hop, freqs, f0, f1, times = _window(stem_path, fps, start, end)
    if f1 <= f0:
        return _EMPTY
    rows, lo, hi = _band_rows(freqs, min_hz, max_hz)
    band = S[rows, f0:f1]
    bf = freqs[rows][:, None]
    mag = band.sum(axis=0)
    cen = (band * bf).sum(axis=0) / np.maximum(mag, 1e-9)
    val = np.clip((cen - lo) / max(hi - lo, 1.0), 0.0, 1.0)
    val[mag < 1e-6] = 0.0
    return val, times


def raw_harmonic(stem_path, start, end, min_hz, max_hz, fps=30):
    """Harmonic share H/(H+P) in the band — tonal/pad vs percussive/noisy."""
    S, sr, hop, freqs, f0, f1, times = _window(stem_path, fps, start, end)
    if f1 <= f0:
        return _EMPTY
    rows, _lo, _hi = _band_rows(freqs, min_hz, max_hz)
    H, P = _hpss(stem_path, fps)
    h = H[rows, f0:f1].sum(axis=0)
    p = P[rows, f0:f1].sum(axis=0)
    return np.clip(h / np.maximum(h + p, 1e-9), 0.0, 1.0), times


def raw_chroma(stem_path, start, end, min_hz, max_hz, fps=30):
    """Dominant pitch class in the band as argmax/11 (0..1) — a stepped curve,
    handy for driving color."""
    S, sr, hop, freqs, f0, f1, times = _window(stem_path, fps, start, end)
    if f1 <= f0:
        return _EMPTY
    rows, _lo, _hi = _band_rows(freqs, min_hz, max_hz)
    Sb = np.zeros_like(S)
    Sb[rows] = S[rows]
    chroma = librosa.feature.chroma_stft(S=Sb[:, f0:f1] ** 2, sr=sr)
    return chroma.argmax(axis=0) / 11.0, times


def _phase(stem_path, start, end, fps, per_bar):
    """Tempo-locked phase 0..1 (beat or 4-beat bar). Band is ignored."""
    S, sr, hop, freqs, f0, f1, times = _window(stem_path, fps, start, end)
    if f1 <= f0:
        return _EMPTY
    tempo, beats = _beats(stem_path, fps)
    period = 60.0 / tempo if tempo > 0 else 0.5
    out = np.zeros(len(times))
    for i, t in enumerate(times):
        if len(beats) == 0:
            pos = t / period
        else:
            k = int(np.searchsorted(beats, t, side="right") - 1)
            if k < 0:
                pos = (t - beats[0]) / period
            elif k >= len(beats) - 1:
                pos = k + (t - beats[-1]) / period
            else:
                span = beats[k + 1] - beats[k]
                pos = k + ((t - beats[k]) / span if span > 0 else 0.0)
        out[i] = (pos / 4.0) % 1.0 if per_bar else pos % 1.0
    return np.clip(out, 0.0, 1.0), times


def raw_beat(stem_path, start, end, min_hz, max_hz, fps=30):
    return _phase(stem_path, start, end, fps, False)


def raw_bar(stem_path, start, end, min_hz, max_hz, fps=30):
    return _phase(stem_path, start, end, fps, True)


def _follower(x: np.ndarray, attack_ms: float, release_ms: float,
              fps: int) -> np.ndarray:
    """Asymmetric one-pole envelope follower. Rising edges use ``attack``,
    falling edges use ``release``; ms→per-frame smoothing coefficient."""
    def coeff(ms: float) -> float:
        if ms <= 0:
            return 0.0                       # instant
        return math.exp(-1.0 / (fps * (ms / 1000.0)))
    ca, cr = coeff(attack_ms), coeff(release_ms)
    out = np.empty_like(x)
    env = 0.0
    for i, target in enumerate(x):
        c = ca if target > env else cr
        env = c * env + (1.0 - c) * float(target)
        out[i] = env
    return out


def shape(raw: np.ndarray, *, attack: float = 5.0, release: float = 250.0,
          invert: bool = False, gamma: float = 1.0, gain: float = 1.0,
          offset: float = 0.0, threshold: float = 0.0,
          fps: int = 30) -> np.ndarray:
    """raw 0..1 -> invert -> follower(attack,release) -> threshold -> gamma ->
    gain/offset -> clamp 0..1 (the fixed shaping order).

    Invert is applied *before* the follower so attack/release act on the flipped
    source: e.g. the kick pump = invert + slow attack + fast release (the curve
    drops fast on the kick, then swells back slowly between hits)."""
    if raw.size == 0:
        return raw
    y = 1.0 - raw if invert else raw
    y = _follower(y, attack, release, fps)
    if threshold > 0.0:
        y = np.clip((y - threshold) / max(1e-6, 1.0 - threshold), 0.0, 1.0)
    if gamma != 1.0:
        y = np.power(np.clip(y, 0.0, 1.0), max(1e-3, gamma))
    y = y * gain + offset
    return np.clip(y, 0.0, 1.0)


# feature name -> raw-curve extractor. All share the cached STFT; the shaping
# pipeline (follower + invert/gamma/gain/offset/threshold) is applied uniformly.
_RAW = {
    "energy": raw_energy,
    "onset": raw_onset,
    "flux": raw_flux,
    "brightness": raw_brightness,
    "harmonic": raw_harmonic,
    "chroma": raw_chroma,
    "beat": raw_beat,
    "bar": raw_bar,
}
FEATURES = list(_RAW)


def extract(stem_path: str | Path, start: float, end: float,
            min_hz: float, max_hz: float, *, feature: str = "energy",
            fps: int = 30, attack: float = 5.0, release: float = 250.0,
            invert: bool = False, gamma: float = 1.0, gain: float = 1.0,
            offset: float = 0.0, threshold: float = 0.0) -> dict:
    """Full extraction for one signal -> ``{curve, times, fps}``."""
    raw_fn = _RAW.get(feature, raw_energy)
    raw, times = raw_fn(stem_path, start, end, min_hz, max_hz, fps)
    curve = shape(raw, attack=attack, release=release, invert=invert,
                  gamma=gamma, gain=gain, offset=offset, threshold=threshold,
                  fps=fps)
    return {"curve": [round(float(v), 4) for v in curve],
            "times": [round(float(t), 3) for t in times],
            "fps": fps}


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 6:
        print("usage: python signals.py <stem.wav> <start> <end> <minHz> <maxHz> "
              "[--invert] [--attack ms] [--release ms]")
        raise SystemExit(1)
    path = sys.argv[1]
    start, end, lo, hi = map(float, sys.argv[2:6])
    args = sys.argv[6:]
    kw = {"invert": "--invert" in args}
    for flag in ("attack", "release", "gamma", "threshold"):
        if f"--{flag}" in args:
            kw[flag] = float(args[args.index(f"--{flag}") + 1])
    out = extract(path, start, end, lo, hi, **kw)
    c = out["curve"]
    print(f"frames={len(c)} fps={out['fps']} "
          f"min={min(c):.3f} max={max(c):.3f} mean={sum(c)/max(1,len(c)):.3f}")
    blocks = "▁▂▃▄▅▆▇█"
    step = max(1, len(c) // 100)
    spark = "".join(blocks[min(7, int(v * 8))] for v in c[::step])
    print(spark)
