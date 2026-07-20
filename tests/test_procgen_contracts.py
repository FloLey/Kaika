"""Direct tests for the generative-card physics kit.

`procgen.py` sits at ~95% LINE coverage with almost no direct tests: every line is walked
transitively by cards rendering, which proves "the card is not black" and nothing else. A
propagator that drifted, a seed that stopped being deterministic, or a tree that grew the
wrong way would all keep those renders green — `assert_moves` would still see motion.

So these assert the properties the cards actually depend on: same seed -> same output,
different seed -> different output, and the physical invariants each routine claims in its
own docstring. That is the difference between covering a line and testing it.
"""

from __future__ import annotations

import numpy as np
import pytest

from backend import procgen

# --------------------------------------------------------------------------- #
# Determinism. Every card takes a `seed` and the UI promises the same seed
# reproduces the same clip — including across a process restart, which is why
# these use explicit seeds rather than comparing two calls in one run only.
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "call",
    [
        pytest.param(lambda s: procgen.fbm2d(24, 32, cells=4, octaves=3, seed=s), id="fbm2d"),
        pytest.param(
            lambda s: procgen.wave_components(s, 6, 40.0, 0.3, 0.4, 0.03, 64), id="wave_components"
        ),
        pytest.param(lambda s: procgen.dbm_tree(s, span=24, max_cells=200)[0], id="dbm_tree"),
    ],
)
def test_same_seed_reproduces_exactly(call):
    a, b = call(7), call(7)
    assert np.array_equal(a, b), "a seeded generator stopped being deterministic"


@pytest.mark.parametrize(
    "call",
    [
        pytest.param(lambda s: procgen.fbm2d(24, 32, cells=4, octaves=3, seed=s), id="fbm2d"),
        pytest.param(
            lambda s: procgen.wave_components(s, 6, 40.0, 0.3, 0.4, 0.03, 64), id="wave_components"
        ),
        pytest.param(lambda s: procgen.dbm_tree(s, span=24, max_cells=200)[0], id="dbm_tree"),
    ],
)
def test_a_different_seed_gives_a_different_result(call):
    """The other half, and the one a broken generator passes: a routine that ignored its
    seed entirely would sail through the determinism test above."""
    a, b = call(1), call(2)
    assert a.shape != b.shape or not np.array_equal(a, b), "the seed is being ignored"


# --------------------------------------------------------------------------- #
# dbm_tree — dielectric-breakdown growth (the lightning card's skeleton)
# --------------------------------------------------------------------------- #


def test_dbm_tree_is_a_tree_rooted_at_the_origin():
    """Every cell must point at an EARLIER cell, and only the root at nothing. A cycle or
    a forward reference would make `dbm_polylines` walk off or loop; on screen that reads
    as a missing bolt, not as a crash."""
    pts, parent, _tip = procgen.dbm_tree(3, span=32, max_cells=400)
    assert len(pts) == len(parent) and len(pts) >= 2
    assert tuple(pts[0]) == (0.0, 0.0), "the root moved"
    assert parent[0] == -1, "the root gained a parent"
    idx = np.arange(1, len(parent))
    assert (parent[1:] >= 0).all(), "a non-root cell has no parent"
    assert (parent[1:] < idx).all(), "a cell points at a later cell — not a tree"


def test_dbm_tree_grows_toward_the_attractor_plane():
    """`bias` exists to pull growth toward y = span. Without it the discharge wanders and
    the card renders a blob instead of a strike."""
    span = 40
    pts, _, _ = procgen.dbm_tree(5, span=span, max_cells=1500)
    assert pts[:, 1].max() > span * 0.5, "growth never approached the attractor"


def test_dbm_tree_respects_max_cells():
    pts, parent, _ = procgen.dbm_tree(11, span=500, max_cells=120)
    assert len(pts) <= 120 and len(parent) == len(pts)


def test_dbm_polylines_returns_paths_that_index_into_the_tree():
    pts, parent, tip = procgen.dbm_tree(3, span=32, max_cells=400)
    branches = list(procgen.dbm_polylines(pts, parent, tip, min_len=2))
    assert branches, "the tree decomposed into no branches at all"
    depths = []
    for points, depth in branches:  # (points (M,2), depth int)
        assert len(points) >= 2 and np.isfinite(points).all()
        depths.append(depth)
    # depth 0 is the main channel to the attractor — exactly one, and it must exist
    assert depths.count(0) == 1, f"expected one main channel, got {depths.count(0)}"


# --------------------------------------------------------------------------- #
# wave_components — deep-water dispersion (the waves card)
# --------------------------------------------------------------------------- #


def test_wave_components_obey_the_deep_water_dispersion_relation():
    """omega = sqrt(g*k) is the physics the card is named for. Rows are (A, kx, ky, w, phi);
    if the propagator drifted, the water would still move — just wrongly."""
    comps = procgen.wave_components(2, 8, 50.0, 0.2, 0.5, 0.04, 128)
    a, kx, ky, omega = comps[:, 0], comps[:, 1], comps[:, 2], comps[:, 3]
    k = np.hypot(kx, ky)
    assert (k > 0).all()
    # g is derived per grid (9.81 * w / _POOL_METERS), not a module constant
    g_px = 9.81 * (128 / procgen._POOL_METERS)
    np.testing.assert_allclose(omega**2, g_px * k, rtol=1e-4)
    # constant steepness a*k across components — the stated realism knob
    np.testing.assert_allclose(a * k, (a * k)[0], rtol=1e-4)


def test_wave_field_is_finite_and_moves_with_time():
    comps = procgen.wave_components(2, 6, 40.0, 0.0, 0.3, 0.03, 64)
    f0 = procgen.wave_field(16, 24, 0.0, comps)
    f1 = procgen.wave_field(16, 24, 0.7, comps)
    h0 = f0[0] if isinstance(f0, tuple) else f0
    h1 = f1[0] if isinstance(f1, tuple) else f1
    assert np.isfinite(h0).all() and h0.shape == (16, 24)
    assert not np.array_equal(h0, h1), "the wave field is frozen in time"


# --------------------------------------------------------------------------- #
# ripple — the capillary-wave propagator (the rain card)
# --------------------------------------------------------------------------- #


def test_ripple_kernel_is_stable_and_damped():
    """|c1| <= 2 and |c2| <= 1 is what keeps the recurrence from exploding. A sign or
    factor error here makes rain blow up after a few seconds — long after any short test
    render has finished looking fine."""
    c1, c2 = procgen.ripple_kernel(32, 32, fps=30.0, speed=1.0, decay=0.5)
    assert np.isfinite(c1).all() and np.isfinite(c2).all()
    assert np.abs(c1).max() <= 2.0 + 1e-5
    assert (c2 <= 0).all() and np.abs(c2).max() <= 1.0 + 1e-5


def test_ripple_step_decays_rather_than_growing():
    c1, c2 = procgen.ripple_kernel(32, 32, fps=30.0, speed=1.0, decay=2.0)
    rng = np.random.default_rng(0)
    u = rng.standard_normal((32, 32)).astype(np.float32)
    hhat, hhat_prev = procgen.ripple_fft(u), procgen.ripple_fft(np.zeros_like(u))
    first = None
    for _ in range(60):
        hhat, hhat_prev = procgen.ripple_step(hhat, hhat_prev, c1, c2)
        energy = float(np.abs(procgen.ripple_ifft(hhat)).max())
        assert np.isfinite(energy), "the ripple propagator diverged"
        first = energy if first is None else first
    assert energy <= first * 2.0, "a damped propagator gained energy"


# --------------------------------------------------------------------------- #
# small helpers with real edge cases
# --------------------------------------------------------------------------- #


def test_sim_dims_caps_the_long_side_and_keeps_aspect_roughly():
    h, w = procgen.sim_dims(2000, 1000, cap=100)
    assert max(h, w) <= 100 and min(h, w) >= 1
    assert h > w, "the aspect flipped"


def test_upscale_returns_the_requested_shape():
    small = np.random.default_rng(0).random((8, 12)).astype(np.float32)
    assert procgen.upscale(small, 32, 48).shape == (32, 48)


def test_smoothstep_clamps_and_hits_its_endpoints():
    np.testing.assert_allclose(
        procgen.smoothstep(np.array([-5.0, 0.0, 0.5, 1.0, 5.0])), [0.0, 0.0, 0.5, 1.0, 1.0]
    )


def test_ramp_lookup_spans_the_palette_without_going_out_of_range():
    stops = procgen.palette_stops("sky", "sky")
    out = procgen.ramp_lookup(np.array([0.0, 0.5, 1.0], np.float32), stops)
    assert out.shape[0] == 3
    assert np.isfinite(out).all() and out.min() >= 0.0
