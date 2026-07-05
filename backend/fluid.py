"""A small real-time fluid simulation (backend), replayed as a looping video.

A simplified port of Kaika's Jos-Stam "stable fluids" solver
(``Kaika/src/kaika/core/simulate.py``): incompressible Navier-Stokes on a
periodic (wrap-around) grid — per step ``vorticity-confine → project → advect →
project → advect-dye → dissipate``. Pressure projection is an exact spectral
(FFT) Poisson solve; advection is semi-Lagrangian (bilinear backtrace). A single
source at the centre injects dye + force every frame.

Kept small + vectorized so a 10 s clip renders in a fraction of a second, then
the UI loops the mp4. numpy + scipy + system ffmpeg only (no new deps).
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

import numpy as np
from scipy import fft as sfft
from scipy.ndimage import map_coordinates


def _series(x, nframes: int) -> np.ndarray:
    """Coerce a scalar or sequence into a float32 array of length nframes.

    Scalars broadcast to a constant array; sequences are linearly resampled onto
    nframes (signals arrive at their own fps, so this is a safety net — callers
    may also pass arrays already of length nframes, which pass through untouched).
    """
    if np.isscalar(x):
        return np.full(nframes, float(x), np.float32)
    arr = np.asarray(x, np.float32).ravel()
    if arr.size == 0:
        return np.zeros(nframes, np.float32)
    if arr.size == nframes:
        return arr
    xs = np.linspace(0.0, 1.0, arr.size)
    xt = np.linspace(0.0, 1.0, nframes)
    return np.interp(xt, xs, arr).astype(np.float32)


def _hex_rgb(s: str) -> np.ndarray:
    s = (s or "#ffffff").lstrip("#")
    if len(s) != 6:
        s = "ffffff"
    return np.array([int(s[i : i + 2], 16) for i in (0, 2, 4)], np.float32) / 255.0


# Render-quality presets -> cells on the SHORT side of the grid. The long side is
# derived from the output aspect (see `grid_for`), matching the original Kaika
# `Canvas.sim_resolution` model. Higher = sharper swirls, slower render.
_QUALITY_CELLS = {"draft": 64, "normal": 96, "high": 144}


def fft_friendly(n: int) -> int:
    """Round `n` to the nearest integer whose only prime factors are 2/3/5, so the
    FFT Poisson projection stays fast on rectangular grids (ported from Kaika)."""

    def ok(k: int) -> bool:
        for p in (2, 3, 5):
            while k % p == 0:
                k //= p
        return k == 1

    lo = hi = int(n)
    while lo > 8 or hi < 4 * int(n):
        if ok(hi):
            return hi
        if lo > 8 and ok(lo):
            return lo
        lo -= 1
        hi += 1
    return int(n)


def grid_for(width: int, height: int, short_cells: int) -> tuple[int, int]:
    """(grid_h, grid_w) simulation cells for an output of `width`x`height`. The
    SHORT side gets `short_cells`; the long side scales with the aspect ratio,
    rounded to an FFT-friendly size — so cells stay ~square (circles stay round)."""
    s = max(16, int(short_cells))
    if width >= height:
        h = s
        w = fft_friendly(int(round(s * width / max(1, height))))
    else:
        w = s
        h = fft_friendly(int(round(s * height / max(1, width))))
    return h, w


def grid_from_output(out: dict) -> tuple[int, int]:
    """(grid_h, grid_w) from an `output` settings dict. An explicit `gridCells`
    (short-side cells) wins — the HD song export uses it to go finer than any quality
    preset; otherwise the quality preset selects the cell count."""
    cells = out.get("gridCells") or _QUALITY_CELLS.get(
        str(out.get("quality", "normal")), _QUALITY_CELLS["normal"]
    )
    return grid_for(int(out.get("width", 1080)), int(out.get("height", 1920)), int(cells))


class FluidSim:
    def __init__(
        self,
        h: int,
        w: int,
        dissipation: float,
        vel_dissipation: float,
        viscosity: float,
        vorticity: float,
        wrap: bool = True,
        dye_modes: list | None = None,
    ):
        # Rectangular grid (h rows x w cols). `short` is the reference dimension
        # that keeps splat size + motion scale consistent across aspect ratios
        # (ported from the original Kaika solver, which was rectangular).
        #
        # `wrap` picks the edge behaviour for advection:
        #   True  — toroidal: fluid that leaves one edge re-enters the opposite.
        #   False — open: fluid advected from outside the grid is empty (mode
        #           "constant", cval 0), so dye/flow that leaves is gone for good.
        # The pressure projection stays spectral/periodic either way (it's the dye
        # advection that's visible), which keeps the open mode cheap + stable.
        self.h, self.w = h, w
        self.short = min(h, w)
        self.wrap = bool(wrap)
        self._adv_mode = "wrap" if self.wrap else "constant"
        self.dissipation = dissipation
        self.vel_dissipation = vel_dissipation
        self.viscosity = viscosity
        self.vorticity = vorticity
        self.u = np.zeros((h, w), np.float32)
        self.v = np.zeros((h, w), np.float32)
        # Dye is split into LAYERS, each advected with its own edge mode, so emitters
        # with different `wrap` can share this one velocity field (they interact) yet
        # have their dye wrap or escape independently (combine merge). With no
        # `dye_modes` it's a single layer matching the velocity edge mode (unchanged).
        self.dye_modes = list(dye_modes) if dye_modes else [self._adv_mode]
        self.dye = [np.zeros((h, w, 3), np.float32) for _ in self.dye_modes]
        # Per-frame divergence source (radial mode only); see add_radial/_project.
        self._src = None
        yy, xx = np.meshgrid(np.arange(h), np.arange(w), indexing="ij")
        self.X = xx.astype(np.float32)  # column index (0..w-1)
        self.Y = yy.astype(np.float32)  # row index (0..h-1)
        # Eigenvalues of the 5-point periodic Laplacian with per-axis periods
        # (h, w), so the spectral Poisson solve works on a rectangular grid.
        a = (
            4.0
            - 2 * np.cos(2 * np.pi * np.arange(h) / h)[:, None]
            - 2 * np.cos(2 * np.pi * np.arange(w) / w)[None, :]
        )
        a[0, 0] = 1.0
        # float32 so the spectral solve stays in complex64 end-to-end: fft2 of the
        # float32 divergence is complex64, and dividing by a float32 array keeps it
        # there (a float64 array here would promote the whole solve to complex128 —
        # ~2x the work/memory for a result we cast back to float32 anyway).
        self._poisson = a.astype(np.float32)

    def _gauss(self, px: float, py: float, radius: float) -> np.ndarray:
        rc = max(1.0, radius * self.short)
        cx, cy = px * self.w, py * self.h
        d2 = (self.X - cx) ** 2 + (self.Y - cy) ** 2
        return np.exp(-d2 / (2 * rc * rc)).astype(np.float32)

    def add_dye(self, px, py, radius, color, amount, layer=0):
        g = self._gauss(px, py, radius)
        self.dye[layer] += (amount * g)[..., None] * color[None, None, :]

    def current_dye(self) -> np.ndarray:
        """The combined dye (sum of all layers) for tonemapping."""
        return self.dye[0] if len(self.dye) == 1 else sum(self.dye)

    def add_force(self, px, py, radius, fx, fy):
        g = self._gauss(px, py, radius)
        self.u += g * fx
        self.v += g * fy

    def add_radial(self, px, py, radius, strength):
        """Omnidirectional outward bloom: accumulate a DIVERGENCE source at the
        emitter, which `_project` turns into a genuine, symmetric radial outflow.

        A literal radial velocity kick (`strength * r_hat`) is irrotational, so the
        incompressibility projection removes ~all of it and leaves only a biased
        single-direction drift — which looked unnatural. A divergence source makes
        the fluid actually expand from the point instead."""
        g = self._gauss(px, py, radius)
        if self._src is None:
            self._src = np.zeros_like(self.u)
        self._src += strength * g

    def _project(self, source=None):
        div = (np.roll(self.u, -1, 1) - self.u) + (np.roll(self.v, -1, 0) - self.v)
        if source is not None:
            # Target a nonzero divergence at the emitter (a genuine source) rather
            # than zero, so the fluid expands outward. Mean-subtract so the net
            # volume change is zero (a central source + a faint distributed sink):
            # keeps the periodic spectral solve stable and yields a recirculating
            # bloom instead of a one-direction drift.
            div = div - (source - source.mean())
        phat = -sfft.fft2(div, workers=-1) / self._poisson
        phat[0, 0] = 0.0
        p = np.real(sfft.ifft2(phat, workers=-1)).astype(np.float32)
        self.u -= p - np.roll(p, 1, 1)
        self.v -= p - np.roll(p, 1, 0)

    def _advect(self, field, mode=None):
        bx = self.X - self.u
        by = self.Y - self.v
        coords = np.stack([by, bx])
        mode = mode or self._adv_mode
        if field.ndim == 2:
            return map_coordinates(field, coords, order=1, mode=mode)
        out = np.empty_like(field)
        for c in range(field.shape[2]):
            out[..., c] = map_coordinates(field[..., c], coords, order=1, mode=mode)
        return out

    def _vorticity(self, eps):
        if eps <= 0:
            return
        eps *= 0.05  # gentle gain — raw curl feedback is unstable otherwise
        curl = (
            (np.roll(self.v, -1, 1) - np.roll(self.v, 1, 1))
            - (np.roll(self.u, -1, 0) - np.roll(self.u, 1, 0))
        ) * 0.5
        absc = np.abs(curl)
        gx = (np.roll(absc, -1, 1) - np.roll(absc, 1, 1)) * 0.5
        gy = (np.roll(absc, -1, 0) - np.roll(absc, 1, 0)) * 0.5
        norm = np.sqrt(gx * gx + gy * gy) + 1e-5
        gx, gy = gx / norm, gy / norm
        self.u += eps * (gy * curl)
        self.v += eps * (-gx * curl)

    def step(self):
        if self.viscosity > 0:
            k = self.viscosity
            denom = 1.0 + 4.0 * k
            for fld in ("u", "v"):
                f = getattr(self, fld)
                # (f + k*sum_of_4_neighbours) / (1+4k), accumulated in-place to avoid
                # the large temporary the one-liner allocated each frame.
                nbr = np.roll(f, 1, 0)
                nbr += np.roll(f, -1, 0)
                nbr += np.roll(f, 1, 1)
                nbr += np.roll(f, -1, 1)
                nbr *= k
                nbr += f
                nbr /= denom
                setattr(self, fld, nbr)
        self._vorticity(self.vorticity)
        self._project(self._src)  # establish the radial outflow (if any source)
        self._src = None  # consume this frame's divergence source
        u0 = self._advect(self.u)
        v0 = self._advect(self.v)
        self.u, self.v = u0, v0
        self._project()  # clean up advection divergence (no source)
        # Advect each dye layer with ITS OWN edge mode (shared velocity field).
        for i, mode in enumerate(self.dye_modes):
            d = self._advect(self.dye[i], mode)
            d *= self.dissipation
            np.clip(d, 0.0, 16.0, out=d)
            self.dye[i] = d
        self.u *= self.vel_dissipation
        self.v *= self.vel_dissipation
        # Stability net: cap speed (keeps advection sane) and kill any NaN/inf.
        vmax = self.short * 0.25
        np.clip(self.u, -vmax, vmax, out=self.u)
        np.clip(self.v, -vmax, vmax, out=self.v)
        np.nan_to_num(self.u, copy=False)
        np.nan_to_num(self.v, copy=False)


def _tonemap(d: np.ndarray, exposure=1.9, gamma=1.15, bg=None) -> np.ndarray:
    ldr = 1.0 - np.exp(-exposure * np.clip(d, 0, None))
    ldr = np.clip(ldr, 0, 1) ** (1.0 / gamma)
    ldr = np.clip(ldr, 0, 1)
    if bg is not None:
        # Composite the (emissive) dye over a solid background via a "screen"
        # blend: black bg -> ldr unchanged (current look); a colored bg shows
        # through where there's no dye and never darkens the glow.
        ldr = 1.0 - (1.0 - bg[None, None, :]) * (1.0 - ldr)
    return (np.clip(ldr, 0, 1) * 255).astype(np.uint8)


def flatten(frames: np.ndarray) -> np.ndarray:
    """Flatten dye `frames` to a 3-channel RGB image on BLACK — the terminal step before
    encoding. A 3-channel (dye-on-black) stack passes straight through; a 4-channel (RGBA,
    e.g. a lyrics layer sent straight to an output) is composited over black using its
    alpha, so an opaque black outline stays black. There is no configurable background any
    more — any backdrop is just the bottom LAYER of a stack combine (spec 10)."""
    if frames.shape[-1] == 3:  # already dye-on-black RGB
        return frames
    f = frames.astype(np.float32) / 255.0
    a = np.clip(f[..., 3:4], 0.0, 1.0)  # RGBA over black -> premultiplied rgb
    return (np.clip(f[..., :3] * a, 0, 1) * 255).astype(np.uint8)


def _emitter(src: dict, nframes: int):
    """Build a per-frame injector for ONE source. Returns `inject(sim, i, denom)`
    that adds this emitter's dye + force to the shared field at frame `i`.

    Every modulatable field is a per-frame series (a scalar broadcasts), so several
    emitters with their own signals can share one simulation (merge)."""
    col = src.get("color", "#46b0ff")
    base_color = np.asarray(col, np.float32) if isinstance(col, (list, tuple)) else _hex_rgb(col)
    # Per-channel colour series default to the static base colour (back-compat).
    r_s = _series(src.get("r", base_color[0]), nframes)
    g_s = _series(src.get("g", base_color[1]), nframes)
    b_s = _series(src.get("b", base_color[2]), nframes)
    emit_s = _series(src.get("emit", 0.3), nframes)
    radius_s = _series(src.get("radius", 0.08), nframes)
    force_s = _series(src.get("force", 20.0), nframes)
    angle_s = _series(src.get("angle", 270.0), nframes)  # deg
    inten_s = _series(src.get("intensity", 1.0), nframes)
    opac_s = _series(src.get("opacity", 1.0), nframes)
    radial = bool(src.get("radial", False))
    enabled = bool(src.get("enabled", True))

    # Source position: a polyline the source travels across the clip (one point
    # = static). pts[k] in 0..1; param t in [0,1] over the whole duration.
    raw_pts = src.get("points") or [[0.5, 0.5]]
    pts = np.array([[float(a), float(b)] for a, b in raw_pts], np.float32)
    path_speed = float(src.get("path_speed", 1.0))  # traversals over the clip
    pingpong = bool(src.get("path_pingpong", False))
    closed = bool(src.get("path_closed", False)) and len(pts) > 2

    # Emission gate (chase): the source stays put but emits as a SNAKE sweeps the ring.
    # A head moves once per `gate_speed` over the clip; each point lights as the head
    # passes and fades behind it. gate_phase = this source's slot (0..1), gate_duty =
    # snake length (lit fraction), gate_fade = tail taper (0 = solid arc, 1 = fade to 0).
    gate_speed = float(src.get("gate_speed", 0.0))
    gate_phase = float(src.get("gate_phase", 0.0))
    gate_duty = float(src.get("gate_duty", 1.0))
    gate_fade = float(src.get("gate_fade", 0.0))
    gated = gate_speed > 0.0 and gate_duty < 1.0

    def gate_at(t):
        if not gated:
            return 1.0
        d = (t * gate_speed - gate_phase) % 1.0  # 0 at the head, grows toward the tail
        if d >= gate_duty:
            return 0.0
        return 1.0 - gate_fade * (d / gate_duty)  # head bright -> tail fades (snake)

    def pos_at(t):
        npts = len(pts)
        if npts == 1:
            return pts[0]
        ph = t * path_speed
        tri = 1.0 - abs((ph % 2.0) - 1.0) if pingpong else (ph % 1.0)
        if closed:  # last point links back to the first
            s = tri * npts
            k = int(np.floor(s)) % npts
            fr = s - np.floor(s)
            return pts[k] * (1.0 - fr) + pts[(k + 1) % npts] * fr
        s = tri * (npts - 1)
        k = int(min(npts - 2, np.floor(s)))
        fr = s - k
        return pts[k] * (1.0 - fr) + pts[k + 1] * fr

    def inject(sim, i, denom, layer=0):
        if not enabled:
            return
        t = i / denom
        g = gate_at(t)
        if g <= 0.0:
            return
        px, py = pos_at(t)
        ang = np.deg2rad(angle_s[i])
        color_i = np.array([r_s[i], g_s[i], b_s[i]], np.float32) * inten_s[i] * opac_s[i]
        sim.add_dye(px, py, radius_s[i], color_i, emit_s[i] * g, layer)
        f = force_s[i] * 0.02 * g  # slider units -> a few cells/frame at steady state
        if radial:
            # Radial uses a divergence source (own gain); it builds outflow over
            # frames, so it wants a smaller per-frame strength than a velocity kick.
            sim.add_radial(px, py, radius_s[i], force_s[i] * 0.05 * g)
        elif f:
            sim.add_force(px, py, radius_s[i], np.cos(ang) * f, np.sin(ang) * f)

    return inject


def _dye_layout(sources: list) -> tuple[list, bool]:
    """(dye_modes, vel_wrap) for a source list. Distinct per-source edge modes become
    separate dye LAYERS over ONE shared velocity field, so a merge of fluids with
    different `wrap` keeps each component's dye behaviour (wraps vs escapes) while they
    still interact. The velocity uses one mode: the common one if uniform, else periodic
    (a torus the whole flow lives on). A single source -> one layer."""
    src_wrap = [bool(s.get("wrap", True)) for s in (sources or [{}])]
    distinct = sorted(set(src_wrap)) or [True]  # [True] / [False] / [False, True]
    dye_modes = ["wrap" if w else "constant" for w in distinct]
    vel_wrap = distinct[0] if len(distinct) == 1 else True
    return dye_modes, vel_wrap


_MEDIUM_DEFAULTS = {
    "dissipation": 0.95,
    "velocity_dissipation": 0.97,
    "viscosity": 0.0,
    "vorticity": 5.0,
}


class LayerInjector:
    """The per-frame "rules" of ONE fluid field over ONE clip/segment window: the medium
    param tracks + emitter injectors, indexed by a clip-LOCAL frame `i` in
    `[0, nframes)`. `apply(sim, i)` sets the medium on `sim` and injects that frame's
    dye/force — it drives an EXTERNAL `FluidSim`, so a persistent field can be advanced
    across many segments (the continuous song export) or a fresh one per clip
    (`FluidClip`). `dye_modes` is the field's dye-layer mode list; each source's `wrap`
    maps to a stable dye-layer index within it (union-of-modes for a shared field)."""

    def __init__(self, params: dict, dye_modes: list):
        fps = int((params.get("output") or {}).get("fps", params.get("fps", 24)))
        duration = float(params.get("duration", 10))
        self.nframes = max(1, int(round(duration * fps)))
        fl = params.get("fluid", {})
        # Medium -> per-frame Python-float lists ONCE (vectorized) so the per-frame
        # update indexes a list instead of calling float() on a numpy scalar each frame.
        self._medium = {
            k: _series(fl.get(k, d), self.nframes).tolist() for k, d in _MEDIUM_DEFAULTS.items()
        }
        sources = params.get("sources") or [params.get("source", {})]
        self._emitters = []
        for s in sources:
            mode = "wrap" if bool(s.get("wrap", True)) else "constant"
            layer = dye_modes.index(mode) if mode in dye_modes else 0
            self._emitters.append((_emitter(s, self.nframes), layer))
        self._denom = max(1, self.nframes - 1)

    def medium0(self, key: str) -> float:
        """This field's frame-0 value for a medium param (to seed a fresh FluidSim)."""
        return self._medium[key][0]

    def apply(self, sim: "FluidSim", i: int) -> None:
        """Set `sim`'s medium from frame `i` and inject this frame's emitters (no step)."""
        sim.dissipation = self._medium["dissipation"][i]
        sim.vel_dissipation = self._medium["velocity_dissipation"][i]
        sim.viscosity = self._medium["viscosity"][i]
        sim.vorticity = self._medium["vorticity"][i]
        for inject, layer in self._emitters:
            inject(sim, i, self._denom, layer)


class FluidClip:
    """A resumable render of one `simulate()` params dict.

    Holds the live `FluidSim` plus the pre-sampled per-frame medium series and
    emitters, so frames can be produced in contiguous **blocks** (front-to-back)
    while the sim state (velocity/dye) carries across `advance()` calls. This is
    what lets a long clip stream in 5s chunks instead of one monolithic render.

    `advance(a, b) -> frames[a:b]` MUST be called with contiguous, increasing
    ranges starting at the current cursor: `advance(0, k)`, then `advance(k, …)`,
    etc. — because block K+1's starting field IS block K's final field, the sim
    cannot skip ahead. `simulate()` is just `advance(0, nframes)` in one call, so
    every existing caller/test stays byte-identical.

    Grid: an `output` dict (width/height/quality) selects a rectangular grid via
    `grid_from_output`; otherwise the legacy square `grid` (FluidLab `/fluid`).
    Emitters: `params["sources"]` is a LIST of source dicts injected together into
    ONE field each frame (merge); a single `params["source"]` is wrapped as
    `[source]`. The medium (`params["fluid"]`) is one shared set.

    `apply_bg`: when True (default) the project background is composited in (the
    standalone single-fluid / FluidLab path). The combine executor passes
    `apply_bg=False` so intermediate layers stay dye-on-transparent and the
    TERMINAL output applies the background once (spec 10)."""

    def __init__(self, params: dict, apply_bg: bool = True):
        out = params.get("output") or {}
        if out:
            self.gh, self.gw = grid_from_output(out)
            self.fps = int(out.get("fps", params.get("fps", 24)))
            bg_rgb = _hex_rgb(out.get("background", "#000000"))
        else:
            self.gh = self.gw = int(params.get("grid", 96))
            self.fps = int(params.get("fps", 24))
            bg_rgb = None
        sources = params.get("sources") or [params.get("source", {})]
        dye_modes, vel_wrap = _dye_layout(sources)
        # The per-frame "rules" (medium tracks + emitter injectors). LayerInjector holds
        # the same math the standalone clip used; here it drives our own sim.
        self._layer = LayerInjector(params, dye_modes)
        self.nframes = self._layer.nframes
        self._sim = FluidSim(
            self.gh,
            self.gw,
            dissipation=self._layer.medium0("dissipation"),
            vel_dissipation=self._layer.medium0("velocity_dissipation"),
            viscosity=self._layer.medium0("viscosity"),
            vorticity=self._layer.medium0("vorticity"),
            wrap=vel_wrap,
            dye_modes=dye_modes,
        )
        self._bg = bg_rgb if apply_bg else None
        self._cursor = 0

    def advance(self, a: int, b: int) -> np.ndarray:
        """Step the sim from frame `a` to `b` (exclusive) and return frames[a:b]."""
        if a != self._cursor:
            raise ValueError(
                f"FluidClip.advance must be contiguous (cursor={self._cursor}, got a={a})"
            )
        b = min(int(b), self.nframes)
        sim = self._sim
        frames = np.empty((max(0, b - a), self.gh, self.gw, 3), np.uint8)
        for i in range(a, b):
            self._layer.apply(sim, i)  # set medium + inject this frame's emitters
            sim.step()
            frames[i - a] = _tonemap(sim.current_dye(), bg=self._bg)
        self._cursor = b
        return frames


def simulate(params: dict, apply_bg: bool = True) -> tuple:
    """Run the sim from a params dict -> (frames uint8 [T,h,w,3], fps, (h,w)).

    Thin wrapper over `FluidClip`: build the clip and advance it over the whole
    range in one call. See `FluidClip` for the grid/emitter/background semantics."""
    clip = FluidClip(params, apply_bg=apply_bg)
    frames = clip.advance(0, clip.nframes)
    return frames, clip.fps, (clip.gh, clip.gw)


def render_mp4(
    frames: np.ndarray,
    fps: int,
    path: Path,
    out_w: int | None = None,
    out_h: int | None = None,
) -> None:
    """Encode RGB frames to a web-playable h264 mp4 via system ffmpeg (one-shot).

    frames are [T, H, W, 3]. `out_w`/`out_h` set the encoded pixel size; they are
    chosen with the SAME aspect as the grid (the sim grid is derived from the
    output size), so the upscale is uniform — no stretch, no bars. Defaults to a
    512px square for the legacy `/fluid` (FluidLab) path. The progressive/streaming
    renderer uses `open_stream_encoder` instead.
    """
    h, w = int(frames.shape[1]), int(frames.shape[2])
    out_w = int(out_w) if out_w else 512
    out_h = int(out_h) if out_h else 512
    out_w -= out_w % 2  # h264 yuv420p needs even dimensions
    out_h -= out_h % 2
    path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-y",
        "-v",
        "error",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-s",
        f"{w}x{h}",
        "-r",
        str(fps),
        "-i",
        "-",
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-vf",
        f"scale={out_w}:{out_h}:flags=neighbor",  # upscale crisply
        str(path),
    ]
    proc = subprocess.run(cmd, input=frames.tobytes(), capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode()[-2000:])


def open_stream_encoder(
    path: Path, fps: int, gw: int, gh: int, out_w: int | None = None, out_h: int | None = None
) -> "subprocess.Popen":
    """Open a persistent ffmpeg that encodes a CONTINUOUS rawvideo stream into `path`.

    The streaming renderer feeds one block's `frames.tobytes()` at a time to the
    returned process's stdin; the sim grid `gw`x`gh` is constant across blocks so a
    single input stream works. Unlike `render_mp4` (one-shot, `+faststart`), the
    output is a FRAGMENTED mp4 (`frag_keyframe+empty_moov`), so the file is
    progressively valid and plays in a `<video>` while it's still growing. The caller
    writes each block, then closes stdin and waits to finalize (see graph.render_stream).
    """
    out_w = int(out_w) if out_w else 512
    out_h = int(out_h) if out_h else 512
    out_w -= out_w % 2  # h264 yuv420p needs even dimensions
    out_h -= out_h % 2
    path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y", "-v", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{gw}x{gh}", "-r", str(fps), "-i", "-",
        "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        # ~1s GOPs with a keyframe at each fragment so partial reads decode cleanly.
        "-g", str(max(1, int(fps))), "-keyint_min", str(max(1, int(fps))), "-sc_threshold", "0",
        "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
        "-vf", f"scale={out_w}:{out_h}:flags=neighbor",
        str(path),
    ]  # fmt: skip
    return subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def params_hash(params: dict) -> str:
    return hashlib.sha1(json.dumps(params, sort_keys=True).encode()).hexdigest()[:16]


if __name__ == "__main__":
    import time

    p = {
        "duration": 10,
        "fps": 24,
        "grid": 96,
        "source": {
            "emit": 0.3,
            "radius": 0.08,
            "force": 20,
            "angle": 270,
            "radial": False,
            "color": "#46b0ff",
            "enabled": True,
        },
        "fluid": {
            "dissipation": 0.95,
            "velocity_dissipation": 0.97,
            "viscosity": 0.0,
            "vorticity": 6.0,
        },
    }
    t0 = time.time()
    frames, fps, n = simulate(p)
    t1 = time.time()
    render_mp4(frames, fps, Path("/tmp/fluid_test.mp4"))
    t2 = time.time()
    print(
        f"sim {t1 - t0:.2f}s ({len(frames)} frames @ {n}px), "
        f"encode {t2 - t1:.2f}s -> /tmp/fluid_test.mp4"
    )
