"""Per-feature smoke tests for the raw signal extractors (B8.4).

`test_signals.py` covers `shape()`; this exercises every feature end-to-end on a
synthetic stem (an amplitude-pulsed tone + noise) and asserts the extractor returns
a normalized, frame-aligned curve.
"""
import numpy as np
import pytest

from backend import signals

soundfile = pytest.importorskip("soundfile")


@pytest.fixture(scope="module")
def stem(tmp_path_factory):
    sr = 22050
    dur = 2.0
    t = np.linspace(0, dur, int(sr * dur), endpoint=False)
    am = 0.5 + 0.5 * np.sin(2 * np.pi * 2 * t)        # 2 Hz amplitude pulse
    rng = np.random.default_rng(0)
    y = (am * np.sin(2 * np.pi * 220 * t) + 0.05 * rng.standard_normal(t.size)).astype(np.float32)
    p = tmp_path_factory.mktemp("audio") / "stem.wav"
    soundfile.write(str(p), y, sr)
    return str(p)


@pytest.mark.parametrize("feature", signals.FEATURES)
def test_extract_returns_normalized_frame_aligned_curve(stem, feature):
    out = signals.extract(stem, 0.0, 2.0, 20.0, 8000.0, feature=feature, fps=30)
    curve, times = out["curve"], out["times"]
    assert len(curve) > 0
    assert len(times) == len(curve)
    assert out["fps"] == 30
    assert all(0.0 <= v <= 1.0 for v in curve), f"{feature} curve out of [0,1]"


def test_unknown_feature_falls_back_to_energy(stem):
    a = signals.extract(stem, 0.0, 2.0, 20.0, 8000.0, feature="energy", fps=30)
    b = signals.extract(stem, 0.0, 2.0, 20.0, 8000.0, feature="nonsense", fps=30)
    assert a["curve"] == b["curve"]
