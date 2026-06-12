"""E1 — Audio analysis.  audio file -> Score (score.json).

Offline, full-track analysis with librosa. The hop length is locked to the
target video framerate so every video frame gets exactly one row of audio
data with no interpolation. Because ``sr / fps`` is not always an integer
(e.g. 44100 / 24 = 1837.5), the hop is rounded and the per-frame timestamps
are recomputed from real time, which bounds the drift to a fraction of a frame.

Version 2 adds chroma (pitch content), spectral flux, beat/bar phase and the
harmonic/percussive ratio, and lets the recipe move the band split and onset
peak-picking strictness (``analysis`` block).
"""
from __future__ import annotations

import hashlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import List, Optional, Sequence

import numpy as np
import librosa

from .score import Score, AudioInfo, Event, FrameData, Section, SCORE_VERSION

N_FFT = 2048
DEFAULT_BANDS = (150.0, 4000.0)
DEFAULT_ONSET_DELTA = 0.10
DEFAULT_ONSET_WAIT = 4
CHROMA_HOP_MULT = 4     # pitch moves far slower than the video framerate


def load_audio(audio_path: str | Path,
               target_sr: Optional[int] = None) -> tuple:
    """(mono float32 waveform, sr). soundfile decodes wav/flac/ogg/mp3
    directly; m4a/aac go through the bundled ffmpeg to a temp wav — faster
    than librosa's audioread fallback, which is deprecated for librosa 1.0."""
    import soundfile as sf
    try:
        y, sr = sf.read(str(audio_path), dtype="float32", always_2d=True)
        y = y.mean(axis=1)
        if target_sr and target_sr != sr:
            y = librosa.resample(y, orig_sr=sr, target_sr=target_sr)
            sr = target_sr
        return y, int(sr)
    except (sf.LibsndfileError, RuntimeError):
        pass
    import subprocess
    import tempfile
    import imageio_ffmpeg
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
        cmd = [ffmpeg, "-y", "-v", "error", "-i", str(audio_path), "-ac", "1"]
        if target_sr:
            cmd += ["-ar", str(int(target_sr))]
        subprocess.run(cmd + [tmp.name], check=True, capture_output=True)
        y, sr = sf.read(tmp.name, dtype="float32", always_2d=True)
    return y.mean(axis=1), int(sr)


def _normalise(x: np.ndarray) -> np.ndarray:
    """Scale to 0..1 by max, robust to all-zero input."""
    x = np.asarray(x, dtype=np.float64)
    peak = float(np.max(x)) if x.size else 0.0
    return x / peak if peak > 1e-12 else np.zeros_like(x)


def _band_onsets(S_band: np.ndarray, sr: int, hop: int,
                 delta: float, wait: int) -> List[Event]:
    """Detect onsets within a single frequency band's magnitude spectrogram.

    The band is expected to be the *percussive* HPSS component: sustained tones
    are already removed, so each detection corresponds to a real hit. Peak
    picking is kept strict (delta/wait) — every onset spawns a visual source,
    so over-triggering turns rhythm into noise.
    """
    if S_band.shape[0] == 0:
        return []
    env = librosa.onset.onset_strength(S=librosa.amplitude_to_db(S_band, ref=np.max),
                                       sr=sr, hop_length=hop)
    if env.max() <= 0:
        return []
    frames = librosa.onset.onset_detect(onset_envelope=env, sr=sr, hop_length=hop,
                                        backtrack=False, delta=delta, wait=wait)
    if len(frames) == 0:
        return []
    times = librosa.frames_to_time(frames, sr=sr, hop_length=hop)
    mags = _normalise(env[frames])
    return [Event(t=float(t), mag=float(m)) for t, m in zip(times, mags)]


def _label_sections(boundaries_t: List[float], duration: float,
                    energies: List[float]) -> List[Section]:
    """Heuristic labelling: ends are intro/outro, the rest build/drop by energy."""
    sections: List[Section] = []
    n = len(boundaries_t) - 1
    e_norm = _normalise(np.array(energies)) if energies else np.array([])
    for i in range(n):
        start, end = boundaries_t[i], boundaries_t[i + 1]
        e = float(e_norm[i]) if i < len(e_norm) else 0.0
        if i == 0:
            label = "intro"
        elif i == n - 1:
            label = "outro"
        elif e >= 0.66:
            label = "drop"
        elif e >= 0.33:
            label = "build"
        else:
            label = "verse"
        sections.append(Section(start=round(start, 3), end=round(end, 3),
                                label=label, energy=round(e, 3)))
    return sections


def _beat_phases(beat_times: np.ndarray, frame_times: np.ndarray,
                 tempo_bpm: float) -> tuple:
    """(beat_phase, bar_phase) per frame. 4/4 assumed; before the first / after
    the last beat the phase free-runs at the detected tempo."""
    n = len(frame_times)
    beat_phase = np.zeros(n)
    bar_phase = np.zeros(n)
    period = 60.0 / tempo_bpm if tempo_bpm > 0 else 0.5
    if len(beat_times) == 0:
        beat_phase = (frame_times / period) % 1.0
        bar_phase = (frame_times / (4 * period)) % 1.0
        return beat_phase, bar_phase
    # Index of the beat preceding each frame (-1 before the first beat).
    idx = np.searchsorted(beat_times, frame_times, side="right") - 1
    for i, t in enumerate(frame_times):
        k = idx[i]
        if k < 0:
            beat_phase[i] = ((t - beat_times[0]) / period) % 1.0
            beats_done = (t - beat_times[0]) / period
        elif k >= len(beat_times) - 1:
            beat_phase[i] = ((t - beat_times[-1]) / period) % 1.0
            beats_done = k + (t - beat_times[-1]) / period
        else:
            span = beat_times[k + 1] - beat_times[k]
            beat_phase[i] = (t - beat_times[k]) / span if span > 0 else 0.0
            beats_done = k + beat_phase[i]
        bar_phase[i] = (beats_done / 4.0) % 1.0
    return np.clip(beat_phase, 0.0, 1.0), np.clip(bar_phase, 0.0, 1.0)


def analyze(audio_path: str | Path, fps: int = 24,
            target_sr: int | None = None,
            bands: Sequence[float] = DEFAULT_BANDS,
            onset_delta: float = DEFAULT_ONSET_DELTA,
            onset_wait: int = DEFAULT_ONSET_WAIT) -> Score:
    """Analyse ``audio_path`` and return a frame-aligned :class:`Score`.

    Parameters
    ----------
    fps : target video framerate; the analysis hop is ``round(sr / fps)``.
    target_sr : optional resample rate. Pick one that divides evenly by ``fps``
        (e.g. 48000 for 24 fps) to eliminate hop rounding drift entirely.
    bands : (low_hz, high_hz) band-split edges for the low/mid/high features.
    onset_delta, onset_wait : onset peak-picking strictness (see recipe
        ``analysis`` block).
    """
    low_hz, high_hz = float(bands[0]), float(bands[1])
    y, sr = load_audio(audio_path, target_sr)
    duration = float(len(y) / sr)
    hop = int(round(sr / fps))

    # Single STFT drives every frame-aligned feature.
    S = np.abs(librosa.stft(y, n_fft=N_FFT, hop_length=hop))
    n = S.shape[1]
    freqs = librosa.fft_frequencies(sr=sr, n_fft=N_FFT)

    rms = _normalise(librosa.feature.rms(S=S)[0])
    centroid = librosa.feature.spectral_centroid(S=S, sr=sr)[0]

    low_mask = freqs < low_hz
    high_mask = freqs > high_hz
    mid_mask = ~low_mask & ~high_mask
    band_low = S[low_mask].sum(0)
    band_mid = S[mid_mask].sum(0)
    band_high = S[high_mask].sum(0)
    band_tot = band_low + band_mid + band_high + 1e-9

    # Spectral flux (onset envelope), the continuous "business" signal.
    onset_env = librosa.onset.onset_strength(S=S, sr=sr, hop_length=hop)
    flux = _normalise(onset_env)
    if len(flux) < n:
        flux = np.pad(flux, (0, n - len(flux)))

    # The three heavy stages are independent: beat tracking, HPSS (median
    # filtering) and CQT chroma all release the GIL in their numpy/scipy
    # cores, so threads genuinely overlap them.
    with ThreadPoolExecutor(max_workers=3) as pool:
        f_beat = pool.submit(librosa.beat.beat_track, y=y, sr=sr,
                             hop_length=hop)
        # HPSS: percussive component for onsets; the split also yields the
        # harmonic ratio (pads vs percussion -> soft vs sharp visuals).
        f_hpss = pool.submit(librosa.decompose.hpss, S)
        # Chroma (pitch content). CQT chroma is best but needs enough
        # samples; fall back to STFT chroma on tiny inputs. Computed at a
        # coarser hop (the CQT dominates analysis time) and repeated back
        # up to the frame grid.
        f_chroma = pool.submit(librosa.feature.chroma_cqt, y=y, sr=sr,
                               hop_length=hop * CHROMA_HOP_MULT)
        tempo, beat_frames = f_beat.result()
        try:
            S_harm, S_perc = f_hpss.result()
        except Exception:
            S_harm, S_perc = S * 0.5, S
        try:
            chroma = np.repeat(f_chroma.result(), CHROMA_HOP_MULT, axis=1)
        except Exception:
            chroma = librosa.feature.chroma_stft(S=S ** 2, sr=sr)

    tempo_bpm = float(np.atleast_1d(tempo)[0])
    beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop)
    beat_strength = _normalise(onset_env[beat_frames]) if len(beat_frames) else np.array([])
    beats = [Event(t=round(float(t), 3), mag=round(float(s), 3))
             for t, s in zip(beat_times, beat_strength)]

    frame_times = librosa.frames_to_time(np.arange(n), sr=sr, hop_length=hop)
    beat_phase, bar_phase = _beat_phases(np.asarray(beat_times), frame_times,
                                         tempo_bpm)

    h_sum = S_harm.sum(0)
    p_sum = S_perc.sum(0)
    harmonic_ratio = h_sum / (h_sum + p_sum + 1e-9)

    if chroma.shape[1] < n:
        chroma = np.pad(chroma, ((0, 0), (0, n - chroma.shape[1])))
    chroma = chroma[:, :n]
    peaks = chroma.max(axis=0)
    chroma_n = chroma / np.where(peaks > 1e-12, peaks, 1.0)[None, :]
    chroma_arg = chroma.argmax(axis=0)

    frames = [
        FrameData(
            rms=round(float(rms[i]), 4),
            centroid_hz=round(float(centroid[i]), 1),
            bands=[round(float(band_low[i] / band_tot[i]), 4),
                   round(float(band_mid[i] / band_tot[i]), 4),
                   round(float(band_high[i] / band_tot[i]), 4)],
            chroma=[round(float(c), 3) for c in chroma_n[:, i]],
            chroma_argmax=int(chroma_arg[i]),
            flux=round(float(flux[i]), 4),
            beat_phase=round(float(beat_phase[i]), 4),
            bar_phase=round(float(bar_phase[i]), 4),
            harmonic_ratio=round(float(harmonic_ratio[i]), 4),
        )
        for i in range(n)
    ]

    onsets = {
        "low": _band_onsets(S_perc[low_mask], sr, hop, onset_delta, onset_wait),
        "mid": _band_onsets(S_perc[mid_mask], sr, hop, onset_delta, onset_wait),
        "high": _band_onsets(S_perc[high_mask], sr, hop, onset_delta, onset_wait),
    }

    # Structural sections via agglomerative clustering on chroma+mfcc.
    sections = _segment(y, sr, hop, S, rms, duration)

    return Score(
        audio=AudioInfo(sr=int(sr), duration_s=round(duration, 3), fps=fps,
                        hop_length=hop),
        tempo_bpm=round(tempo_bpm, 2),
        beats=beats,
        onsets=onsets,
        frames=frames,
        sections=sections,
        version=SCORE_VERSION,
    )


def audio_cache_key(audio_path: str | Path) -> str:
    """Content hash of an audio file — stable across uploads of the same
    track and across the frozen per-run copies."""
    h = hashlib.sha1()
    with open(audio_path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:20]


def analyze_cached(audio_path: str | Path, cache_dir: Optional[str | Path],
                   fps: int = 24,
                   bands: Sequence[float] = DEFAULT_BANDS,
                   onset_delta: float = DEFAULT_ONSET_DELTA,
                   onset_wait: int = DEFAULT_ONSET_WAIT) -> Score:
    """:func:`analyze`, memoised on (file content, analysis params): the
    upload->analyze->project flow re-analyses the same track several times,
    and resubmitting a track costs a full analysis for nothing. With
    ``cache_dir=None`` this is a plain passthrough."""
    if cache_dir is None:
        return analyze(audio_path, fps=fps, bands=bands,
                       onset_delta=onset_delta, onset_wait=onset_wait)
    params = f"{fps}-{float(bands[0])}-{float(bands[1])}-" \
             f"{onset_delta}-{onset_wait}-v{SCORE_VERSION}"
    p = Path(cache_dir) / f"{audio_cache_key(audio_path)}-{params}.json"
    if p.exists():
        return Score.from_json(p)
    score = analyze(audio_path, fps=fps, bands=bands,
                    onset_delta=onset_delta, onset_wait=onset_wait)
    p.parent.mkdir(parents=True, exist_ok=True)
    score.to_json(p)
    return score


def _segment(y, sr, hop, S, rms, duration) -> List[Section]:
    """Boundaries from agglomerative clustering, ~one section per 25s."""
    k = max(2, min(8, int(round(duration / 25.0)) + 1))
    chroma = librosa.feature.chroma_stft(S=S ** 2, sr=sr)
    mfcc = librosa.feature.mfcc(y=y, sr=sr, hop_length=hop, n_mfcc=13)
    # Align feature lengths to the chroma frame count.
    m = min(chroma.shape[1], mfcc.shape[1], len(rms))
    feat = np.vstack([chroma[:, :m], mfcc[:, :m]])
    try:
        bound_frames = librosa.segment.agglomerative(feat, k)
    except Exception:
        bound_frames = np.linspace(0, m - 1, k + 1).astype(int)
    bound_frames = np.unique(np.concatenate([[0], bound_frames, [m]]))
    bound_t = librosa.frames_to_time(bound_frames, sr=sr, hop_length=hop).tolist()
    bound_t[0] = 0.0
    bound_t[-1] = duration
    energies = []
    for i in range(len(bound_t) - 1):
        f0 = bound_frames[i]
        f1 = max(f0 + 1, bound_frames[i + 1])
        energies.append(float(np.mean(rms[f0:f1])) if f1 <= len(rms) else 0.0)
    return _label_sections(bound_t, duration, energies)
