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

    per_frame_delta = np.abs(frames_arr.astype(int) - frames_const.astype(int)).mean()
    assert per_frame_delta > 0.1, (
        f"param {key!r} ({group}) is not applied per-frame " f"(delta={per_frame_delta:.3f})"
    )


def test_scalar_path_unchanged() -> None:
    """A scalar param == a constant array of that scalar (FluidLab path intact)."""
    p = _base()
    a, _, _ = fluid.simulate(p)
    p2 = _base()
    p2["source"]["force"] = [p2["source"]["force"]] * N
    b, _, _ = fluid.simulate(p2)
    assert np.abs(a.astype(int) - b.astype(int)).mean() < 0.01


def test_wrap_defaults_to_torus() -> None:
    """`wrap` defaults True (the existing toroidal behaviour) when unset."""
    sim = fluid.FluidSim(8, 8, 0.95, 0.97, 0.0, 5.0)
    assert sim.wrap is True and sim._adv_mode == "wrap"
    open_sim = fluid.FluidSim(8, 8, 0.95, 0.97, 0.0, 5.0, wrap=False)
    assert open_sim.wrap is False and open_sim._adv_mode == "constant"


def test_open_edges_let_dye_escape() -> None:
    """Open edges (wrap=False) let a jet drive dye off the frame, so less dye
    remains than the torus where it re-enters the opposite edge."""

    def last_frame_brightness(wrap: bool) -> float:
        p = _base()
        p["source"].update(
            emit=0.5, force=55.0, angle=90.0, radius=0.07, color=[1.0, 1.0, 1.0], wrap=wrap
        )
        p["fluid"].update(dissipation=0.99, velocity_dissipation=0.99)
        frames, _, _ = fluid.simulate(p)
        return float(frames[-1].mean())

    torus = last_frame_brightness(True)
    open_edges = last_frame_brightness(False)
    assert open_edges < torus * 0.8  # markedly less dye left on screen


def test_radial_source_blooms_omnidirectionally() -> None:
    """Radial mode (a divergence source) spreads dye out in ALL directions with no
    single-direction drift — the original irrotational kick was projected away and
    left a biased one-way flow."""
    p = _base()
    p["source"].update(emit=0.5, force=30.0, radial=True, radius=0.07, color=[1.0, 1.0, 1.0])
    p["fluid"].update(dissipation=0.97, velocity_dissipation=0.97, vorticity=2.0)
    frames, _, (h, w) = fluid.simulate(p)
    last = frames[-1].mean(axis=2).astype(np.float32)  # grayscale dye, last frame
    yy, xx = np.meshgrid(np.arange(h), np.arange(w), indexing="ij")
    cx, cy = w / 2.0, h / 2.0
    total = float(last.sum()) + 1e-6

    # Dye centroid stays near the centre source (a one-way drift would move it far).
    drift = float(np.hypot((xx * last).sum() / total - cx, (yy * last).sum() / total - cy))
    assert drift < min(h, w) * 0.06  # << any real directional bias

    # Dye is spread across all four quadrants around the source, roughly balanced.
    quads = [
        float(last[: h // 2, : w // 2].sum()),
        float(last[: h // 2, w // 2 :].sum()),
        float(last[h // 2 :, : w // 2].sum()),
        float(last[h // 2 :, w // 2 :].sum()),
    ]
    assert min(quads) > 0 and max(quads) / min(quads) < 1.6


def test_project_without_source_unchanged() -> None:
    """`_project(None)` is the plain incompressible solve (directional path intact)."""
    rng = np.random.default_rng(0)
    sim = fluid.FluidSim(16, 16, 0.95, 0.97, 0.0, 5.0)
    sim.u = rng.standard_normal((16, 16)).astype(np.float32)
    sim.v = rng.standard_normal((16, 16)).astype(np.float32)
    u0 = sim.u.copy()
    sim._project(None)
    # Divergence-free after projection (the source-free behaviour we always had).
    div = (np.roll(sim.u, -1, 1) - sim.u) + (np.roll(sim.v, -1, 0) - sim.v)
    assert np.abs(div).max() < 1e-3
    assert not np.allclose(sim.u, u0)  # it actually did something
