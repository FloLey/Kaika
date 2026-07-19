"""Behavioural unit tests for the fluid solver internals (spec 03).

fluid.py was only perf/dtype-tested; these cover the visible behaviour on tiny
grids (fast): tonemap clamping, dye dissipation, and the wrap-vs-open edge mode.
"""

import numpy as np
import pytest

fluid = pytest.importorskip("backend.fluid")

WHITE = np.array([1.0, 1.0, 1.0], np.float32)


def test_tonemap_clamps_to_uint8_and_blacks_out_empty_dye():
    d = np.zeros((4, 4, 3), np.float32)
    d[1, 1, :] = 50.0  # absurdly bright dye (HDR)
    out = fluid._tonemap(d)
    assert out.dtype == np.uint8
    assert out.min() >= 0 and out.max() <= 255
    assert (out[0, 0] == 0).all()  # no dye -> black
    assert (out[1, 1] > 0).all()  # bright dye -> lit, but bounded


class _DyeRecorder:
    """Minimal sim stub that records the dye amount each emitter inject() asks for."""

    def __init__(self):
        self.amounts = []

    def add_dye(self, px, py, radius, color, amount, layer=0):
        self.amounts.append(float(amount))

    def add_force(self, *a, **k):
        pass

    def add_radial(self, *a, **k):
        pass


def test_emitter_snake_gate_bright_head_fading_tail_dark_outside():
    # A chase snake: slot 0, body length 0.5 of the loop, fully tapered (head->tail).
    src = {
        "emit": 1.0,
        "force": 0.0,
        "gate_speed": 1.0,
        "gate_phase": 0.0,
        "gate_duty": 0.5,
        "gate_fade": 1.0,
    }
    inject = fluid._emitter(src, nframes=11)
    rec = _DyeRecorder()
    inject(rec, 0, 10)  # t=0, d=0 -> the head, full brightness
    assert rec.amounts == pytest.approx([1.0])
    rec.amounts.clear()
    inject(rec, 2, 10)  # t=0.2, d=0.2 in body, u=0.2/0.5=0.4 -> g=0.6
    assert rec.amounts == pytest.approx([0.6])
    rec.amounts.clear()
    inject(rec, 7, 10)  # t=0.7, d=0.7 >= 0.5 -> behind the tail, dark
    assert rec.amounts == []


def test_emitter_snake_no_taper_is_a_solid_arc():
    # taper 0 -> the whole body emits at full strength (a solid sliding arc).
    src = {
        "emit": 1.0,
        "force": 0.0,
        "gate_speed": 1.0,
        "gate_phase": 0.0,
        "gate_duty": 0.5,
        "gate_fade": 0.0,
    }
    inject = fluid._emitter(src, nframes=11)
    rec = _DyeRecorder()
    inject(rec, 2, 10)  # in the body -> full (no taper)
    assert rec.amounts == pytest.approx([1.0])
    rec.amounts.clear()
    inject(rec, 7, 10)  # outside the body -> dark
    assert rec.amounts == []


def test_dissipation_decays_static_dye_by_the_dissipation_factor():
    # Zero velocity -> advection is identity, so one step just multiplies the dye
    # by `dissipation`.
    sim = fluid.FluidSim(16, 16, dissipation=0.5, vel_dissipation=0.9, viscosity=0.0, vorticity=0.0)
    sim.add_dye(0.5, 0.5, 0.1, WHITE, amount=1.0)
    before = float(sim.current_dye().sum())
    sim.step()
    after = float(sim.current_dye().sum())
    assert after < before
    assert after == pytest.approx(before * 0.5, rel=0.05)


def test_wrap_retains_dye_that_open_lets_escape():
    # Advect a blob sitting near the right edge under a uniform rightward velocity.
    # Toroidal (wrap) re-enters on the left and conserves total dye; open mode pulls
    # in empty space from outside, so dye that leaves is gone.
    def total_after_advect(wrap: bool) -> float:
        sim = fluid.FluidSim(
            8, 8, dissipation=1.0, vel_dissipation=1.0, viscosity=0.0, vorticity=0.0, wrap=wrap
        )
        sim.dye[0][:] = 0.0
        sim.dye[0][3:5, 6:8, :] = 1.0  # blob near the right edge
        sim.u[:] = 2.0  # uniform rightward velocity
        sim.v[:] = 0.0
        for _ in range(10):
            sim.dye[0] = sim._advect(sim.dye[0], sim._adv_mode)
        return float(sim.dye[0].sum())

    assert total_after_advect(True) > total_after_advect(False)


def test_simulate_returns_a_bounded_uint8_clip_on_a_tiny_grid():
    params = {
        "duration": 0.3,
        "fps": 10,
        "grid": 16,
        "source": {
            "emit": 0.3,
            "radius": 0.1,
            "force": 10,
            "angle": 270,
            "radial": False,
            "wrap": True,
            "enabled": True,
            "color": [0.3, 0.7, 1.0],
            "intensity": 1.0,
            "opacity": 1.0,
            "points": [[0.5, 0.5]],
            "path_speed": 1,
            "path_closed": False,
            "path_pingpong": False,
        },
        "fluid": {
            "dissipation": 0.95,
            "velocity_dissipation": 0.97,
            "viscosity": 0.0,
            "vorticity": 5.0,
        },
    }
    frames, fps, (h, w) = fluid.simulate(params)
    assert fps == 10
    assert (h, w) == (16, 16)
    assert frames.dtype == np.uint8
    assert frames.ndim == 4 and frames.shape[3] == 3
    assert frames.shape[0] == 3  # 0.3s * 10fps
    assert frames.min() >= 0 and frames.max() <= 255
    assert np.isfinite(frames).all()
