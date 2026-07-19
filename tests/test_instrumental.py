"""The instrumental pseudo-stem: a lazy vocals-removed mix cached next to the
demucs stems, served by `stem_audio_path` for both the export mux
(`export.audioMode == "instrumental"`) and the studio transport route.

v2 is a PHASE SUBTRACTION (original − vocals) — it keeps everything demucs did
not classify as vocal, where the old drums+bass+other sum dropped the residual
the four stems fail to reassemble. The sum remains the fallback when the
original is missing.
"""

import shutil
import subprocess

import numpy as np
import pytest
import soundfile as sf

from backend import media

_needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


def _sine(path, freq, duration=0.2):
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency={freq}:duration={duration}",
            str(path),
        ],
        check=True,
        capture_output=True,
    )


def _synth_stems(stem_dir, names=("drums", "bass", "other")):
    """Tiny sine-wave wavs standing in for demucs output."""
    stem_dir.mkdir(parents=True, exist_ok=True)
    for i, name in enumerate(names):
        _sine(stem_dir / f"{name}.wav", 220 * (i + 1))


@_needs_ffmpeg
def test_subtraction_recovers_the_music_and_caches(tmp_path):
    # original = music + vocals; instrumental must be ≈ music (original − vocals).
    stem_dir = tmp_path / "model" / "song"
    stem_dir.mkdir(parents=True)
    music = tmp_path / "music.wav"
    _sine(music, 220)
    _sine(stem_dir / "vocals.wav", 440)
    original = tmp_path / "original.wav"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-i",
            str(music),
            "-i",
            str(stem_dir / "vocals.wav"),
            "-filter_complex",
            "amix=inputs=2:normalize=0",
            str(original),
        ],
        check=True,
        capture_output=True,
    )

    out = media._ensure_instrumental(stem_dir, original)
    assert out is not None and out.name == "instrumental-v2.wav" and out.stat().st_size > 0

    got, sr = sf.read(out)
    if got.ndim > 1:
        got = got.mean(axis=1)
    # Scale-agnostic spectral check (a MONO source upmixes at -3dB, which is fine —
    # both sides scale identically so the vocal still cancels): the 440Hz vocal is
    # gone, the 220Hz music survives.
    spec = np.abs(np.fft.rfft(got))
    freqs = np.fft.rfftfreq(len(got), 1 / sr)
    band = lambda f: float(spec[(freqs > f - 15) & (freqs < f + 15)].max())  # noqa: E731
    assert band(220) > 0  # music present
    assert band(440) < 0.05 * band(220)  # vocal removed

    # Second call is a pure cache hit (same file, no rebuild).
    mtime = out.stat().st_mtime
    assert media._ensure_instrumental(stem_dir, original) == out
    assert out.stat().st_mtime == mtime


@_needs_ffmpeg
def test_sum_fallback_without_an_original(tmp_path):
    stem_dir = tmp_path / "model" / "song"
    _synth_stems(stem_dir)
    out = media._ensure_instrumental(stem_dir)  # no original -> drums+bass+other sum
    assert out is not None and out.name == "instrumental-v2.wav" and out.stat().st_size > 0


@_needs_ffmpeg
def test_v1_sum_cache_is_retired(tmp_path):
    # A stale v1 file (the old amix product) must not be served; building v2
    # removes it so the directory holds one canonical instrumental.
    stem_dir = tmp_path / "model" / "song"
    _synth_stems(stem_dir)
    legacy = stem_dir / "instrumental.wav"
    legacy.write_bytes(b"stale")
    out = media._ensure_instrumental(stem_dir)
    assert out is not None and out.name == "instrumental-v2.wav"
    assert not legacy.exists()


def test_ensure_instrumental_needs_sources(tmp_path):
    stem_dir = tmp_path / "model" / "song"
    stem_dir.mkdir(parents=True)
    (stem_dir / "drums.wav").write_bytes(b"x")  # bass/other missing, no original
    assert media._ensure_instrumental(stem_dir) is None


@_needs_ffmpeg
def test_stem_audio_path_serves_the_pseudo_stem(tmp_path, monkeypatch):
    monkeypatch.setattr(media, "SEPARATED_DIR", tmp_path)
    monkeypatch.setattr(media, "UPLOAD_DIR", tmp_path / "uploads")  # no original: sum path
    _synth_stems(tmp_path / "job1" / "model" / "song")
    p = media.stem_audio_path("job1", "instrumental")
    assert p is not None and p.name == "instrumental-v2.wav" and p.exists()
    # Unknown stems still refuse.
    assert media.stem_audio_path("job1", "nonsense") is None
