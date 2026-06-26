"""Unit tests for the HTTP helpers (Phase 4). Needs flask (backend.web imports it)
but not the ML stack, so it runs wherever flask is installed."""

import pytest

pytest.importorskip("flask")

from backend.web import validate_audio_params


def test_validate_audio_params_coerces_and_returns():
    assert validate_audio_params({"start": 0, "end": 2, "minHz": 40, "maxHz": 120, "fps": 30}) == (
        0.0,
        2.0,
        40.0,
        120.0,
        30,
    )


def test_validate_audio_params_defaults():
    start, end, lo, hi, fps = validate_audio_params({"start": 0.0, "end": 1.0})
    assert (lo, hi, fps) == (20.0, 20000.0, 30)


def test_validate_audio_params_accepts_nyquist_band():
    # maxHz goes up to the stem's Nyquist (sr/2): 22050 @ 44.1k, 24000 @ 48k.
    for nyq in (22050.0, 24000.0, 48000.0):
        _, _, _, hi, _ = validate_audio_params({"start": 0, "end": 1, "minHz": 20, "maxHz": nyq})
        assert hi == nyq


def test_validate_audio_params_rejects_bad_window():
    with pytest.raises(ValueError):
        validate_audio_params({"start": 2.0, "end": 1.0})


def test_validate_audio_params_rejects_inverted_band():
    with pytest.raises(ValueError):
        validate_audio_params({"start": 0, "end": 1, "minHz": 200, "maxHz": 100})


def test_validate_audio_params_rejects_bad_fps():
    with pytest.raises(ValueError):
        validate_audio_params({"start": 0, "end": 1, "fps": 0})
