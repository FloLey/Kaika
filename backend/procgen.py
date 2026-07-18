"""Shared simulation helpers for the generative source cards (waves / fire /
lightning / aurora / rain / clouds).

Each card is a *physical* simulation, not dressed-up noise; this module holds the
reusable physics/rendering kit (specs/generative-cards-v2/):

- 2-D fractal value noise (`fbm2d`) — still the base texture for aurora rays and
  cloud density (it wraps, so it scrolls forever);
- directional **wave spectra** with the deep-water dispersion ω = √(gk) and
  analytic gradients/Hessians (`wave_components` / `wave_field`) — pool water;
- **caustics** by forward-splatting the refraction-map Jacobian (`caustic_map`)
  and bilinear displacement sampling (`displace`) — catastrophe-optics filaments;
- **dielectric-breakdown** Laplacian growth for lightning (`dbm_tree`), the
  charge-superposition variant (no field solve; Kim/Sewall/Sud/Lin 2007);
- a spectral **capillary-wave propagator** for rain rings (`ripple_kernel` /
  `ripple_step`, exact dispersion ω² = gk + sk³, per-k damping);
- a Planck **blackbody ramp** for fire (`blackbody_stops`);
- internal-grid helpers (`sim_dims` / `upscale`) — sims run on a capped grid and
  upscale bilinearly;
- the named-palette catalog + vectorised ramp lookup.

numpy + scipy (both already backend deps — the fluid solver uses the same pair);
PIL only for rasterising bolt polylines (in `sources`).
"""

from __future__ import annotations

import numpy as np
from scipy import fft as sfft
from scipy.ndimage import gaussian_filter, map_coordinates, zoom


def smoothstep(t):
    """The classic 3t²−2t³ ease (same curve `_noise_curve` uses in 1-D)."""
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def _value_noise_2d(
    h: int, w: int, res_y: int, res_x: int, seed: int, off_y: float = 0.0, off_x: float = 0.0
) -> np.ndarray:
    """One octave of 2-D value noise on an (h, w) grid, sampled from a
    `(res_y, res_x)` random lattice with smoothstep interpolation. The lattice
    wraps (modulo indexing), so `off_y`/`off_x` can scroll it by any amount and it
    still tiles seamlessly — the basis for continuous animation. Deterministic
    from `seed`. Returns float32 (h, w) in ~0..1."""
    res_y = max(1, int(res_y))
    res_x = max(1, int(res_x))
    lat = np.random.default_rng(seed).random((res_y, res_x), dtype=np.float32)
    gy = np.linspace(0.0, res_y, h, endpoint=False, dtype=np.float32) + off_y
    gx = np.linspace(0.0, res_x, w, endpoint=False, dtype=np.float32) + off_x
    y0 = np.floor(gy).astype(np.int64)
    x0 = np.floor(gx).astype(np.int64)
    fy = smoothstep(gy - y0)[:, None]
    fx = smoothstep(gx - x0)[None, :]
    y0m, y1m = y0 % res_y, (y0 + 1) % res_y
    x0m, x1m = x0 % res_x, (x0 + 1) % res_x
    v00 = lat[np.ix_(y0m, x0m)]
    v01 = lat[np.ix_(y0m, x1m)]
    v10 = lat[np.ix_(y1m, x0m)]
    v11 = lat[np.ix_(y1m, x1m)]
    top = v00 * (1.0 - fx) + v01 * fx
    bot = v10 * (1.0 - fx) + v11 * fx
    return top * (1.0 - fy) + bot * fy


def fbm2d(
    h: int,
    w: int,
    *,
    cells: int = 6,
    octaves: int = 4,
    seed: int = 0,
    scroll_y: float = 0.0,
    scroll_x: float = 0.0,
) -> np.ndarray:
    """Animated 2-D fractal value noise, normalised to ~0..1. `cells` is the base
    frequency (lattice cells across the frame); each octave doubles it and halves
    its amplitude. `scroll_x/scroll_y` translate the field in world units (scaled
    per octave so every octave moves together) — advance them with time for
    smooth motion. Deterministic from `seed`."""
    total = np.zeros((h, w), np.float32)
    amp, norm, c = 1.0, 0.0, int(cells)
    for o in range(max(1, int(octaves))):
        total += amp * _value_noise_2d(
            h, w, c, c, seed + o * 1013, off_y=scroll_y * c, off_x=scroll_x * c
        )
        norm += amp
        amp *= 0.5
        c *= 2
    return (total / max(norm, 1e-6)).astype(np.float32)


# ── Named palettes ────────────────────────────────────────────────────────────
# Each ramp is a list of (t, (r, g, b)) stops in 0..1, indexed by a 0..1 field
# value (e.g. wave height, flame heat). A wired `color` card overrides these (see
# graph_render._wired_stops). `ramp_lookup` interpolates them vectorised.
PALETTES: dict[str, list[tuple[float, tuple[float, float, float]]]] = {
    # waves: deep water -> shallows -> foam. The sand tone is derived separately.
    "ocean": [
        (0.0, (0.02, 0.08, 0.15)),
        (0.5, (0.04, 0.34, 0.44)),
        (0.78, (0.30, 0.66, 0.70)),
        (1.0, (0.93, 0.97, 0.96)),
    ],
    "tropical": [
        (0.0, (0.01, 0.20, 0.30)),
        (0.5, (0.05, 0.55, 0.60)),
        (0.8, (0.35, 0.82, 0.78)),
        (1.0, (0.96, 0.99, 0.95)),
    ],
    "storm": [
        (0.0, (0.05, 0.07, 0.09)),
        (0.5, (0.16, 0.20, 0.24)),
        (0.8, (0.42, 0.48, 0.52)),
        (1.0, (0.86, 0.89, 0.90)),
    ],
    "sunset": [
        (0.0, (0.10, 0.06, 0.18)),
        (0.5, (0.55, 0.24, 0.32)),
        (0.8, (0.92, 0.55, 0.38)),
        (1.0, (1.00, 0.92, 0.78)),
    ],
    # fire: transparent/cool base -> deep red -> orange -> yellow-white.
    "flame": [
        (0.0, (0.06, 0.00, 0.00)),
        (0.4, (0.72, 0.10, 0.02)),
        (0.72, (0.98, 0.55, 0.10)),
        (1.0, (1.00, 0.96, 0.80)),
    ],
    "blue-fire": [
        (0.0, (0.00, 0.02, 0.08)),
        (0.4, (0.05, 0.28, 0.85)),
        (0.72, (0.35, 0.72, 1.00)),
        (1.0, (0.90, 0.98, 1.00)),
    ],
    "green-fire": [
        (0.0, (0.00, 0.05, 0.02)),
        (0.4, (0.06, 0.55, 0.16)),
        (0.72, (0.45, 0.95, 0.35)),
        (1.0, (0.92, 1.00, 0.85)),
    ],
    "ghost": [
        (0.0, (0.02, 0.03, 0.05)),
        (0.4, (0.12, 0.30, 0.40)),
        (0.72, (0.40, 0.70, 0.82)),
        (1.0, (0.90, 0.98, 1.00)),
    ],
    # lightning: the bolt/glow colour scheme (core stays near-white; ends tint).
    "electric": [(0.0, (0.30, 0.50, 1.00)), (0.6, (0.65, 0.80, 1.00)), (1.0, (1.0, 1.0, 1.0))],
    "violet": [(0.0, (0.55, 0.25, 1.00)), (0.6, (0.80, 0.60, 1.00)), (1.0, (1.0, 1.0, 1.0))],
    "white-hot": [(0.0, (0.75, 0.82, 0.95)), (0.6, (0.92, 0.95, 1.00)), (1.0, (1.0, 1.0, 1.0))],
    "ember": [(0.0, (1.00, 0.55, 0.20)), (0.6, (1.00, 0.78, 0.45)), (1.0, (1.0, 0.98, 0.9))],
    # aurora: colour by ALTITUDE in the curtain (0 = bottom edge -> 1 = top),
    # matching the real emission stratification: N2+ purple fringe at the very
    # bottom, oxygen green 557.7 nm above it, oxygen red 630 nm at the top.
    "aurora": [
        (0.0, (0.55, 0.20, 0.95)),
        (0.18, (0.10, 1.00, 0.45)),
        (0.62, (0.16, 0.75, 0.55)),
        (1.0, (0.90, 0.22, 0.34)),
    ],
    "solar": [(0.0, (0.95, 0.35, 0.20)), (0.5, (1.00, 0.70, 0.25)), (1.0, (1.00, 0.95, 0.70))],
    "ice": [(0.0, (0.25, 0.55, 0.95)), (0.5, (0.55, 0.80, 1.00)), (1.0, (0.95, 0.99, 1.00))],
    "spectrum": [
        (0.0, (0.95, 0.30, 0.40)),
        (0.35, (0.95, 0.90, 0.30)),
        (0.65, (0.30, 0.90, 0.55)),
        (1.0, (0.45, 0.45, 0.95)),
    ],
    # rain: streak intensity -> tint (2-stop reads as a monochrome shower).
    "downpour": [(0.0, (0.18, 0.32, 0.55)), (1.0, (0.75, 0.88, 1.00))],
    "silver": [(0.0, (0.35, 0.38, 0.42)), (1.0, (0.95, 0.97, 1.00))],
    "neon": [(0.0, (0.15, 0.55, 0.55)), (1.0, (0.55, 1.00, 0.95))],
    "monsoon": [(0.0, (0.30, 0.30, 0.36)), (1.0, (0.85, 0.82, 0.72))],
    # clouds/nebula: density -> colour (dark wisps -> bright billows).
    "sky": [(0.0, (0.05, 0.10, 0.20)), (0.5, (0.50, 0.60, 0.75)), (1.0, (0.98, 0.99, 1.00))],
    "nebula": [
        (0.0, (0.03, 0.02, 0.10)),
        (0.45, (0.35, 0.12, 0.55)),
        (0.75, (0.20, 0.55, 0.85)),
        (1.0, (0.90, 0.85, 1.00)),
    ],
    "ink": [(0.0, (0.02, 0.02, 0.03)), (0.6, (0.20, 0.22, 0.26)), (1.0, (0.70, 0.74, 0.80))],
    "dust": [(0.0, (0.10, 0.06, 0.03)), (0.5, (0.55, 0.32, 0.16)), (1.0, (1.00, 0.85, 0.60))],
}


def palette_stops(name: str, fallback: str) -> list:
    return PALETTES.get(name, PALETTES[fallback])


def _install_blackbody_flame() -> None:
    """The default fire palette is the physical Planck locus, not hand stops
    (called at import, bottom of module — after `blackbody_stops` exists)."""
    PALETTES["flame"] = blackbody_stops()


def ramp_lookup(values: np.ndarray, stops: list) -> np.ndarray:
    """Map a 0..1 array through colour `stops` [(t, (r, g, b))] -> `(*values.shape, 3)`
    float32 rgb, linear between stops and clamped at the ends. Vectorised."""
    ts = np.asarray([s[0] for s in stops], np.float32)
    cols = np.asarray([s[1] for s in stops], np.float32)  # (K, 3)
    v = np.clip(values, 0.0, 1.0)
    out = np.empty(v.shape + (3,), np.float32)
    for ch in range(3):
        out[..., ch] = np.interp(v, ts, cols[:, ch])
    return out


# ── Internal simulation grid ──────────────────────────────────────────────────
# Simulations run on a capped grid (physics cost is resolution-bound) and the
# resulting *fields* upscale bilinearly; refraction displacement then applies at
# full render resolution, so the output stays sharp even when the sim is coarse.

SIM_CAP = 512  # max long-side of any card's internal simulation grid


def sim_dims(h: int, w: int, cap: int = SIM_CAP) -> tuple[int, int]:
    """Internal sim dims for an (h, w) render grid: cap the long side, keep the
    aspect, force even (FFT-friendly, clean 2× relationships)."""
    m = max(h, w)
    if m <= cap:
        return h, w
    s = cap / m
    return max(2, round(h * s / 2) * 2), max(2, round(w * s / 2) * 2)


def upscale(field: np.ndarray, h: int, w: int) -> np.ndarray:
    """Bilinear-resize a float (ih, iw[, C]) field to (h, w). `grid_mode` gives
    image-resize semantics (corners map to corners)."""
    if field.shape[:2] == (h, w):
        return field
    z = (h / field.shape[0], w / field.shape[1]) + (1.0,) * (field.ndim - 2)
    return zoom(field, z, order=1, mode="nearest", grid_mode=True).astype(np.float32)


def displace(img: np.ndarray, disp_x: np.ndarray, disp_y: np.ndarray) -> np.ndarray:
    """Sample `img` (h, w[, C]) at (x + disp_x, y + disp_y), bilinear and
    edge-clamped — the refraction warp for waves/rain (a *gather*: each output
    pixel looks up where its ray came from)."""
    hh, ww = img.shape[:2]
    ys = np.clip(np.arange(hh, dtype=np.float32)[:, None] + disp_y, 0, hh - 1)
    xs = np.clip(np.arange(ww, dtype=np.float32)[None, :] + disp_x, 0, ww - 1)
    ys, xs = np.broadcast_arrays(ys, xs)
    coords = (ys, xs)
    if img.ndim == 2:
        return map_coordinates(img, coords, order=1, mode="nearest")
    return np.stack(
        [
            map_coordinates(img[..., c], coords, order=1, mode="nearest")
            for c in range(img.shape[2])
        ],
        axis=-1,
    )


# ── Directional wave spectra (waves card) ─────────────────────────────────────
# A calm pool is a handful of discrete disturbance/reflection modes, not a wind
# ocean — so 8-12 hand-built directional sines (GPU Gems 1 ch.1 recipe) with the
# deep-water dispersion relation as the physical glue: long waves visibly outrun
# short ones, the single biggest "reads as water" cue.

_POOL_METERS = 4.0  # the frame spans ~4 m of pool — fixes the dispersion clock


def wave_components(
    seed: int, n: int, wavelength: float, direction: float, spread: float, steepness: float, w: int
) -> np.ndarray:
    """Build `n` sine components: wavelengths log-spaced in [0.5, 2]·`wavelength`
    (px), directions fanned ±`spread` rad around `direction` with the last two
    reflected (pool walls bounce waves back), **constant steepness** a·k =
    `steepness` across components (the realism knob — real calm-pool slopes are
    ak ≈ 0.01-0.06), ω = √(g k) in px units. Rows are (A, kx, ky, ω, φ)."""
    rng = np.random.default_rng(seed)
    lam = wavelength * np.exp(rng.uniform(np.log(0.5), np.log(2.0), n))
    ang = direction + rng.uniform(-spread, spread, n)
    if n >= 4:
        ang[-2:] = direction + np.pi + rng.uniform(-spread, spread, 2) * 0.5
    k = 2.0 * np.pi / np.maximum(lam, 4.0)  # ≥ 4 px wavelength (aliasing floor)
    g_px = 9.81 * (w / _POOL_METERS)  # gravity in px/s² at this grid scale
    out = np.stack(
        [
            steepness / k,
            k * np.cos(ang),
            k * np.sin(ang),
            np.sqrt(g_px * k),
            rng.uniform(0, 2 * np.pi, n),
        ],
        axis=1,
    )
    return out.astype(np.float32)


def wave_field(h: int, w: int, t: float, comps: np.ndarray):
    """Evaluate the sine sum on an (h, w) grid at time `t` -> the height field
    and its ANALYTIC first/second derivatives (the caustic Jacobian needs clean
    Hessians — never finite-difference). Returns (hgt, hx, hy, hxx, hxy, hyy)."""
    yy = np.arange(h, dtype=np.float32)[:, None]
    xx = np.arange(w, dtype=np.float32)[None, :]
    acc = [np.zeros((h, w), np.float32) for _ in range(6)]
    hgt, hx, hy, hxx, hxy, hyy = acc
    for a, kx, ky, om, ph in comps:
        arg = kx * xx + ky * yy - om * t + ph
        s = np.sin(arg)
        c = np.cos(arg)
        hgt += a * s
        hx += a * kx * c
        hy += a * ky * c
        hxx -= a * kx * kx * s
        hxy -= a * kx * ky * s
        hyy -= a * ky * ky * s
    return hgt, hx, hy, hxx, hxy, hyy


def caustic_map(
    disp_x: np.ndarray, disp_y: np.ndarray, det: np.ndarray, gamma: float, i_max: float = 6.0
) -> np.ndarray:
    """Pool-floor caustics: forward-splat `min(1/|det J|, i_max)` at each texel's
    refracted landing spot (4 bilinear `np.add.at` scatters), light blur, mean
    normalisation and display gamma. |det J| → 0 on the fold curves of the
    refraction map (Berry & Upstill catastrophe optics) — the splat lands that
    energy where the rays actually focus, giving paired filaments with cusps
    that pinch and merge as the waves evolve."""
    hh, ww = det.shape
    inten = np.minimum(1.0 / np.maximum(np.abs(det), 1e-2), i_max).astype(np.float32)
    ys = np.clip(np.arange(hh, dtype=np.float32)[:, None] + disp_y, 0.0, hh - 1.001)
    xs = np.clip(np.arange(ww, dtype=np.float32)[None, :] + disp_x, 0.0, ww - 1.001)
    ys, xs = np.broadcast_arrays(ys, xs)
    y0 = ys.astype(np.int32)
    x0 = xs.astype(np.int32)
    fy = (ys - y0).astype(np.float32)
    fx = (xs - x0).astype(np.float32)
    out = np.zeros((hh, ww), np.float32)
    np.add.at(out, (y0, x0), inten * (1 - fy) * (1 - fx))
    np.add.at(out, (y0, x0 + 1), inten * (1 - fy) * fx)
    np.add.at(out, (y0 + 1, x0), inten * fy * (1 - fx))
    np.add.at(out, (y0 + 1, x0 + 1), inten * fy * fx)
    out = gaussian_filter(out, 1.15)  # wide enough to fuse the splat beading
    out /= max(float(out.mean()), 1e-6)
    return out**gamma


# ── Dielectric-breakdown lightning (lightning card) ───────────────────────────
# Laplacian growth (Niemeyer et al. 1984) grows the hierarchical self-avoiding
# branching of real discharges — every tip screens the field around it, so
# branches repel and curve apart, which no fractal subdivision can fake. The
# charge-superposition variant (Kim/Sewall/Sud/Lin 2007) needs no Laplace solve:
# each candidate's potential is a running sum over placed point charges, updated
# vectorised as cells are added — a full bolt costs tens of ms.

_DBM_R = 0.7  # point-charge radius in cell units


def dbm_tree(
    seed: int, *, span: int = 160, eta: float = 2.5, bias: float = 2.0, max_cells: int = 4000
):
    """Grow one discharge in a local integer lattice: root at (0, 0), ambient
    field biasing growth toward the attractor plane y = `span` (the strike
    target). `eta` is THE branching knob (η≈2 dense Lichtenberg → η≳4 bare
    channel). Returns (pts float32 (N, 2) xy in cell units, parent int32 (N,))
    — a tree, terminated when a cell reaches the attractor (or `max_cells`)."""
    rng = np.random.default_rng(seed)
    charges = np.zeros((max_cells, 2), np.float32)
    parent = np.full(max_cells, -1, np.int32)
    n = 1  # cells placed so far; cell 0 is the root
    # Candidate pool as parallel arrays (swap-pop removal): position, potential
    # SUM over placed charges (mean = sum / n), and the cluster cell that spawned
    # each candidate (= its parent if it gets picked).
    nbrs = np.array(
        [(dx, dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1) if (dx, dy) != (0, 0)], np.float32
    )
    cand_pos = nbrs.copy()
    cand_sum = np.zeros(len(nbrs), np.float32)
    cand_par = np.zeros(len(nbrs), np.int32)
    d0 = np.hypot(cand_pos[:, 0], cand_pos[:, 1])
    cand_sum += 1.0 - _DBM_R / np.maximum(d0, _DBM_R)
    in_cluster = {(0.0, 0.0)}
    in_cand = {tuple(p) for p in cand_pos}
    hit = -1
    while n < max_cells and hit < 0 and len(cand_pos):
        phi = cand_sum / n
        lo, hi = float(phi.min()), float(phi.max())
        # screening term^η picks the winning tip; the ambient field enters as a
        # MULTIPLICATIVE depth preference (candidates behind the leading edge
        # decay exponentially) — added linearly it would swamp the screening
        # after min-max normalisation and the front would advance as a fan.
        w8 = ((phi - lo) / max(hi - lo, 1e-6)) ** eta + 1e-9
        w8 = w8 * np.exp(bias * (cand_pos[:, 1] - cand_pos[:, 1].max()) / span * 8.0)
        pick = int(rng.choice(len(w8), p=w8 / w8.sum()))
        pos = cand_pos[pick].copy()
        charges[n] = pos
        parent[n] = cand_par[pick]
        in_cluster.add(tuple(pos))
        in_cand.discard(tuple(pos))
        # swap-pop the picked candidate, then fold the new charge into the rest
        last = len(cand_pos) - 1
        cand_pos[pick], cand_sum[pick], cand_par[pick] = (
            cand_pos[last],
            cand_sum[last],
            cand_par[last],
        )
        cand_pos, cand_sum, cand_par = (cand_pos[:last], cand_sum[:last], cand_par[:last])
        if len(cand_pos):
            d = np.hypot(cand_pos[:, 0] - pos[0], cand_pos[:, 1] - pos[1])
            cand_sum += 1.0 - _DBM_R / np.maximum(d, _DBM_R)
        # new candidates around the added cell
        fresh = []
        for dx, dy in nbrs:
            p = (float(pos[0] + dx), float(pos[1] + dy))
            if p in in_cluster or p in in_cand:
                continue
            in_cand.add(p)
            fresh.append(p)
        if fresh:
            fp = np.asarray(fresh, np.float32)
            d = np.hypot(
                fp[:, None, 0] - charges[None, : n + 1, 0],
                fp[:, None, 1] - charges[None, : n + 1, 1],
            )
            fs = (1.0 - _DBM_R / np.maximum(d, _DBM_R)).sum(1).astype(np.float32)
            cand_pos = np.concatenate([cand_pos, fp])
            cand_sum = np.concatenate([cand_sum, fs])
            cand_par = np.concatenate([cand_par, np.full(len(fp), n, np.int32)])
        if pos[1] >= span:
            hit = n
        n += 1
    return charges[:n].copy(), parent[:n].copy(), (hit if hit >= 0 else n - 1)


def dbm_polylines(pts: np.ndarray, parent: np.ndarray, tip: int, min_len: int = 4):
    """Decompose the DBM tree into branch polylines -> list of
    (points float32 (M, 2), depth int). Depth 0 is the main channel (attractor
    tip backtracked to the root); every other chain's depth is 1 + its anchor's.
    Chains run from a junction/root down to a leaf, anchor point included so
    branches connect visually; chains shorter than `min_len` cells are lattice
    hair, not branches — pruned (their sub-branches are pruned with them)."""
    n = len(pts)
    children: list[list[int]] = [[] for _ in range(n)]
    for i in range(1, n):
        children[parent[i]].append(i)
    main: list[int] = []
    i = tip
    while i >= 0:
        main.append(i)
        i = parent[i]
    main.reverse()
    on_main = np.zeros(n, bool)
    on_main[main] = True
    depth = np.full(n, -1, np.int32)
    depth[main] = 0
    out = [(pts[main].copy(), 0)]
    # walk depth-first from every junction cell, splitting chains at junctions
    stack = [(m, c) for m in main for c in children[m] if not on_main[c]]
    while stack:
        anchor, head = stack.pop()
        chain = [anchor]
        d = depth[anchor] + 1
        i = head
        spawns = []  # sub-branches found along this chain — kept only if it is
        while True:
            chain.append(i)
            depth[i] = d
            kids = children[i]
            if len(kids) == 1:
                i = kids[0]
                continue
            for c in kids:
                spawns.append((i, c))
            break
        if len(chain) >= max(2, min_len):
            out.append((pts[chain].copy(), int(d)))
            stack.extend(spawns)
    return out


def jitter_polyline(pl: np.ndarray, rng, rounds: int = 2, sigma: float = 0.29) -> np.ndarray:
    """Midpoint-displacement polish for sub-lattice tortuosity: each round
    inserts midpoints offset perpendicular by N(0, σ·seg_len), σ halved per
    round. σ = tan(16°) ≈ 0.29 matches the measured Gaussian direction-change
    statistics of real return-stroke channels (Hill 1968)."""
    p = pl.astype(np.float32)
    for _ in range(max(0, rounds)):
        if len(p) < 2:
            return p
        a, b = p[:-1], p[1:]
        seg = b - a
        ln = np.hypot(seg[:, 0], seg[:, 1])[:, None]
        nrm = np.stack([-seg[:, 1], seg[:, 0]], 1) / np.maximum(ln, 1e-6)
        mid = (a + b) * 0.5 + nrm * (rng.standard_normal((len(a), 1)) * sigma * ln)
        p = np.empty((len(a) * 2 + 1, 2), np.float32)
        p[0::2] = np.concatenate([a[:1], b])
        p[1::2] = mid
        sigma *= 0.5
    return p


# ── Spectral capillary-wave propagator (rain card) ────────────────────────────
# Exact linear water-wave dynamics on a periodic grid: every Fourier mode is an
# independent damped oscillator, stepped by ĥ⁺ = 2 d cos(ωΔt) ĥ − d² ĥ⁻ with the
# REAL dispersion ω² = g k + s k³ — capillary ripples outrun the main ring (the
# "drop on water" signature) — and per-k viscous damping d = exp(−ν k² Δt).
# Unconditionally stable, 2 FFTs per frame; the grid is padded ~25% by the
# caller and cropped so the periodic wrap never shows.

_RIPPLE_G = 900.0  # gravity term, px/s² — sets the big-ring speed
_RIPPLE_S = 9000.0  # capillary term, px³/s² — sets the fine leading ripples


def ripple_kernel(h: int, w: int, fps: float, speed: float, decay: float):
    """Precompute the per-mode step coefficients (c1, c2) for an (h, w) padded
    grid: ĥ⁺ = c1·ĥ + c2·ĥ⁻. `speed` scales ω (dispersion shape preserved);
    `decay` is ν in px²/s — small ν keeps rings alive across the frame."""
    ky = 2 * np.pi * np.fft.fftfreq(h)[:, None]
    kx = 2 * np.pi * np.fft.fftfreq(w)[None, :]
    k = np.hypot(ky, kx).astype(np.float32)
    dt = 1.0 / max(fps, 1e-6)
    omega = speed * np.sqrt(_RIPPLE_G * k + _RIPPLE_S * k**3)
    d = np.exp(-decay * k**2 * dt).astype(np.float32)
    c1 = (2.0 * d * np.cos(omega * dt)).astype(np.float32)
    c2 = (-(d * d)).astype(np.float32)
    return c1, c2


def ripple_step(hhat, hhat_prev, c1, c2):
    """One propagator step in spectral space -> (ĥ⁺, ĥ)."""
    return c1 * hhat + c2 * hhat_prev, hhat


def ripple_ifft(hhat) -> np.ndarray:
    """Spectral state -> real height field (float32)."""
    return sfft.ifft2(hhat).real.astype(np.float32)


def ripple_fft(u: np.ndarray):
    return sfft.fft2(u.astype(np.float32))


def mexican_hat(sigma: float) -> np.ndarray:
    """Zero-sum drop stamp ψ ∝ (1 − r²/2σ²) e^(−r²/2σ²) — a Gaussian dimple
    carries net volume (a permanent dent under weak damping, plus a dirty
    interior afterglow); the Laplacian-of-Gaussian sheds a clean expanding ring
    train with the central rebound overshoot of a real crater collapse."""
    r = max(2, int(np.ceil(3.0 * sigma)))
    yy, xx = np.mgrid[-r : r + 1, -r : r + 1].astype(np.float32)
    r2 = (yy * yy + xx * xx) / max(sigma * sigma, 1e-6)
    psi = (1.0 - 0.5 * r2) * np.exp(-0.5 * r2)
    psi -= psi.mean()  # exact zero volume
    return (psi / max(float(np.abs(psi).max()), 1e-6)).astype(np.float32)


# ── Blackbody ramp (fire card) ────────────────────────────────────────────────


def _cie_lobe(lam, mu, s1, s2):
    s = np.where(lam < mu, s1, s2)
    return np.exp(-0.5 * ((lam - mu) / s) ** 2)


def blackbody_stops(t_min: float = 650.0, t_max: float = 2400.0, n: int = 9) -> list:
    """Planck-locus palette stops for flame shading: T in [t_min, t_max] K →
    sRGB via Planck radiance × CIE fits (Wyman et al. multi-lobe x̄ȳz̄) → XYZ →
    sRGB, each stop normalised to its max channel (chromaticity ramp — the
    emission *intensity* comes from the sim's T^4 alpha, not the ramp) with a
    soft luminance lift so the sequence reads dim-red → orange → white-hot."""
    lam = np.arange(380.0, 781.0, 5.0) * 1e-9  # metres
    xbar = (
        1.056 * _cie_lobe(lam * 1e9, 599.8, 37.9, 31.0)
        + 0.362 * _cie_lobe(lam * 1e9, 442.0, 16.0, 26.7)
        - 0.065 * _cie_lobe(lam * 1e9, 501.1, 20.4, 26.2)
    )
    ybar = 0.821 * _cie_lobe(lam * 1e9, 568.8, 46.9, 40.5) + 0.286 * _cie_lobe(
        lam * 1e9, 530.9, 16.3, 31.1
    )
    zbar = 1.217 * _cie_lobe(lam * 1e9, 437.0, 11.8, 36.0) + 0.681 * _cie_lobe(
        lam * 1e9, 459.0, 26.0, 13.8
    )
    m = np.array(
        [[3.2406, -1.5372, -0.4986], [-0.9689, 1.8758, 0.0415], [0.0557, -0.2040, 1.0570]],
        np.float64,
    )
    c2 = 1.4388e-2  # m·K
    raw = []
    for i in range(n):
        temp = t_min + (t_max - t_min) * i / (n - 1)
        planck = 1.0 / (lam**5 * (np.exp(c2 / (lam * temp)) - 1.0))
        xyz = np.array([(planck * b).sum() for b in (xbar, ybar, zbar)])
        raw.append(np.maximum(m @ xyz, 0.0))
    # von Kries chromatic adaptation to the hottest temperature present (the
    # Fedkiw fire-paper lesson): without it the whole ramp renders orange — the
    # eye white-balances to the flame core, so the top stop must be white.
    white = np.maximum(raw[-1], 1e-12)
    stops = []
    for i, rgb in enumerate(raw):
        t = i / (n - 1)
        rgb = rgb / white
        rgb /= max(float(rgb.max()), 1e-12)
        rgb = rgb ** (1.0 / 2.2)
        lift = 0.12 + 0.88 * t  # dim red base → full-bright white tip
        stops.append((float(t), tuple(float(v * lift) for v in rgb)))
    return stops


_install_blackbody_flame()
