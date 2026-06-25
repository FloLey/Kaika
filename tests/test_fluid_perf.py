"""Guards for the Phase 6 sim perf wins (32-bit spectral solve + in-place viscosity).

These pin the dtypes so a future change can't silently promote the Poisson solve to
complex128 (~2x the work) or break the in-place viscosity diffusion.
"""
import numpy as np
import scipy.fft as sfft

from backend import fluid


def _sim(viscosity=0.0):
    return fluid.FluidSim(32, 32, dissipation=0.95, vel_dissipation=0.97,
                          viscosity=viscosity, vorticity=6.0)


def test_poisson_solve_stays_complex64():
    sim = _sim()
    assert sim._poisson.dtype == np.float32
    div = (np.roll(sim.u, -1, 1) - sim.u) + (np.roll(sim.v, -1, 0) - sim.v)
    phat = -sfft.fft2(div, workers=-1) / sim._poisson
    assert phat.dtype == np.complex64   # float64 _poisson would promote to complex128


def test_step_keeps_velocity_float32_and_finite():
    sim = _sim(viscosity=0.3)        # exercise the in-place viscosity diffusion
    sim.add_force(0.5, 0.5, 0.1, 8.0, 0.0)
    sim.add_dye(0.5, 0.5, 0.1, np.array([0.3, 0.7, 1.0], np.float32), 1.0)
    for _ in range(3):
        sim.step()
    assert sim.u.dtype == np.float32 and sim.v.dtype == np.float32
    assert np.isfinite(sim.u).all() and np.isfinite(sim.current_dye()).all()
