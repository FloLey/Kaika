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
    am = 0.5 + 0.5 * np.sin(2 * np.pi * 2 * t)  # 2 Hz amplitude pulse
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


class TestBrightnessIsLogarithmic:
    """`raw_brightness` maps the centroid across the band by OCTAVES, not by Hz.

    Linearly, a real musical centroid (~1-2 kHz) landed at ~5% of a full
    20 Hz-22 kHz band and moved by ~4% across a whole segment: the curve rested on
    the floor whatever the music did, on the feature whose job is to say "this got
    brighter". These pin the property rather than the numbers — a tone at the
    geometric middle of a band must read ~0.5, which is true of a log mapping and
    false of a linear one.
    """

    @staticmethod
    def _tone(tmp_path, hz, sr=44100, dur=1.5):
        import soundfile as sf

        t = np.linspace(0, dur, int(sr * dur), endpoint=False)
        y = (0.5 * np.sin(2 * np.pi * hz * t)).astype(np.float32)
        p = tmp_path / f"tone{hz}.wav"
        sf.write(str(p), y, sr)
        return str(p)

    def test_a_tone_at_the_geometric_centre_reads_about_half(self, tmp_path):
        # 100 Hz .. 10 kHz spans ~6.6 octaves; its geometric centre is 1 kHz.
        # Log -> ~0.5. Linear would put 1 kHz at (1000-100)/9900 = 0.09.
        v, _ = signals.raw_brightness(self._tone(tmp_path, 1000), 0.2, 1.2, 100, 10000)
        assert 0.42 < float(np.mean(v)) < 0.58

    def test_the_band_edges_still_map_to_zero_and_one(self, tmp_path):
        lo, _ = signals.raw_brightness(self._tone(tmp_path, 100), 0.2, 1.2, 100, 10000)
        hi, _ = signals.raw_brightness(self._tone(tmp_path, 10000), 0.2, 1.2, 100, 10000)
        assert float(np.mean(lo)) < 0.12
        assert float(np.mean(hi)) > 0.88

    def test_each_octave_up_moves_the_curve_by_the_same_amount(self, tmp_path):
        # The defining property: equal musical intervals are equal distances. Over
        # 100 Hz..10 kHz an octave is 1/log2(100) of the range, so ~0.1 per octave.
        means = [
            float(
                np.mean(signals.raw_brightness(self._tone(tmp_path, hz), 0.2, 1.2, 100, 10000)[0])
            )
            for hz in (500, 1000, 2000, 4000)
        ]
        steps = np.diff(means)
        assert np.all(steps > 0), f"not monotonic: {means}"
        # Linear mapping would give steps of 0.05, 0.10, 0.20 — doubling each time.
        assert float(steps.max() - steps.min()) < 0.04, f"steps not even: {steps}"

    def test_a_band_reaching_zero_hz_stays_finite(self, tmp_path):
        # log(0) is -inf; the floor keeps a user-dragged 0 Hz edge usable.
        v, _ = signals.raw_brightness(self._tone(tmp_path, 1000), 0.2, 1.2, 0, 22050)
        assert np.all(np.isfinite(v)) and np.all((v >= 0) & (v <= 1))

    def test_a_degenerate_band_does_not_divide_by_zero(self, tmp_path):
        v, _ = signals.raw_brightness(self._tone(tmp_path, 1000), 0.2, 1.2, 1000, 1000)
        assert np.all(np.isfinite(v)) and np.all((v >= 0) & (v <= 1))
