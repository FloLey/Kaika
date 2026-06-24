"""Unit tests for the signal shaping pipeline (signals.shape).

`shape` is the deterministic, model-free core every feature passes through, so a
small contract test here catches the breakage-prone bit without needing audio,
demucs, or a database. Run with: ``.venv/bin/python -m pytest``.
"""
import numpy as np

from signals import shape


def _steady(value, n=200):
    """A constant input long enough for the envelope follower to settle."""
    return np.full(n, float(value))


def test_empty_input_returns_empty():
    out = shape(np.zeros(0))
    assert out.size == 0


def test_output_always_clamped_0_1():
    out = shape(_steady(0.4), gain=5.0, offset=0.7)
    assert out.min() >= 0.0 and out.max() <= 1.0


def test_steady_passthrough():
    # A constant signal with neutral shaping settles to itself.
    out = shape(_steady(0.6))
    assert np.isclose(out[-1], 0.6, atol=1e-2)


def test_gain_scales():
    out = shape(_steady(0.4), gain=2.0)
    assert np.isclose(out[-1], 0.8, atol=1e-2)


def test_offset_clamps_high():
    out = shape(_steady(0.4), gain=2.0, offset=0.5)  # 0.8 + 0.5 -> clamp 1.0
    assert np.isclose(out[-1], 1.0, atol=1e-6)


def test_invert_flips():
    # Inverting a steady-high input yields a steady-low curve.
    out = shape(_steady(1.0), invert=True)
    assert np.isclose(out[-1], 0.0, atol=1e-2)


def test_threshold_gates_below():
    out = shape(_steady(0.2), threshold=0.5)
    assert np.isclose(out[-1], 0.0, atol=1e-6)


def test_gamma_darkens():
    out = shape(_steady(0.25), gamma=2.0)  # 0.25**2 = 0.0625
    assert np.isclose(out[-1], 0.0625, atol=1e-2)
