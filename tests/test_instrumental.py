"""The instrumental pseudo-stem: a lazy vocals-removed mix (drums+bass+other)
cached next to the demucs stems, served by `stem_audio_path` for both the export
mux (`export.audioMode == "instrumental"`) and the studio transport route."""

import shutil
import subprocess

import pytest

from backend import media

_needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


def _synth_stems(stem_dir, names=("drums", "bass", "other")):
    """Tiny sine-wave wavs standing in for demucs output."""
    stem_dir.mkdir(parents=True, exist_ok=True)
    for i, name in enumerate(names):
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-f", "lavfi",
             "-i", f"sine=frequency={220 * (i + 1)}:duration=0.2",
             str(stem_dir / f"{name}.wav")],
            check=True, capture_output=True,
        )


@_needs_ffmpeg
def test_ensure_instrumental_mixes_and_caches(tmp_path):
    stem_dir = tmp_path / "model" / "song"
    _synth_stems(stem_dir)
    out = media._ensure_instrumental(stem_dir)
    assert out is not None and out.name == "instrumental.wav" and out.stat().st_size > 0
    # Second call is a pure cache hit (same file, no rebuild).
    mtime = out.stat().st_mtime
    assert media._ensure_instrumental(stem_dir) == out
    assert out.stat().st_mtime == mtime


def test_ensure_instrumental_needs_all_three_stems(tmp_path):
    stem_dir = tmp_path / "model" / "song"
    stem_dir.mkdir(parents=True)
    (stem_dir / "drums.wav").write_bytes(b"x")  # bass/other missing
    assert media._ensure_instrumental(stem_dir) is None


@_needs_ffmpeg
def test_stem_audio_path_serves_the_pseudo_stem(tmp_path, monkeypatch):
    monkeypatch.setattr(media, "SEPARATED_DIR", tmp_path)
    _synth_stems(tmp_path / "job1" / "model" / "song")
    p = media.stem_audio_path("job1", "instrumental")
    assert p is not None and p.name == "instrumental.wav" and p.exists()
    # Unknown stems still refuse.
    assert media.stem_audio_path("job1", "nonsense") is None
