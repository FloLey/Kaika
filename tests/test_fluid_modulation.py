"""Every modulatable fluid param must accept a per-frame ARRAY (a wired pulse) and
actually change the render frame-to-frame — not crash, not be ignored.

Regression guard for the bug where the medium params (dissipation / velocity_
dissipation / viscosity / vorticity) were passed straight into ``float()`` in the
FluidSim constructor, so a signal-driven array blew up the render with a 500.
"""
from __future__ import annotations

import numpy as np
import pytest

from backend import fluid
from backend.animation_params import PARAMS

GRID = 32
FPS = 24
DUR = 3
N = DUR * FPS


def _base() -> dict:
    src = {k: PARAMS[k][3] for k in PARAMS if PARAMS[k][0] == "source"}
    fl = {k: PARAMS[k][3] for k in PARAMS if PARAMS[k][0] == "fluid"}
    src["color"] = [0.3, 0.7, 1.0]
    src["enabled"] = True
    return {"grid": GRID, "fps": FPS, "duration": DUR, "source": src, "fluid": fl}


def _triangle(n: int) -> np.ndarray:
    x = np.linspace(0, 1, n)
    return np.abs(2 * ((x * 2) % 1) - 1)


@pytest.mark.parametrize("key", list(PARAMS))
def test_param_accepts_per_frame_array(key: str) -> None:
    group, lo, hi, _ = PARAMS[key]
    arr = (lo + (hi - lo) * _triangle(N)).tolist()

    # An array must not crash, and must differ from the same param flattened to a
    # constant (its mean) — i.e. the per-frame value is genuinely honored.
    p_arr = _base()
    p_arr[group][key] = arr
    frames_arr, _, _ = fluid.simulate(p_arr)

    p_const = _base()
    p_const[group][key] = float(np.mean(arr))
    frames_const, _, _ = fluid.simulate(p_const)

    per_frame_delta = np.abs(
        frames_arr.astype(int) - frames_const.astype(int)
    ).mean()
    assert per_frame_delta > 0.1, (
        f"param {key!r} ({group}) is not applied per-frame "
        f"(delta={per_frame_delta:.3f})"
    )


def test_scalar_path_unchanged() -> None:
    """A scalar param == a constant array of that scalar (FluidLab path intact)."""
    p = _base()
    a, _, _ = fluid.simulate(p)
    p2 = _base()
    p2["source"]["force"] = [p2["source"]["force"]] * N
    b, _, _ = fluid.simulate(p2)
    assert np.abs(a.astype(int) - b.astype(int)).mean() < 0.01
