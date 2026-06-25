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
    return np.array([int(s[i:i + 2], 16) for i in (0, 2, 4)], np.float32) / 255.0


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
    """(grid_h, grid_w) from an `output` settings dict (width/height/quality)."""
    cells = _QUALITY_CELLS.get(str(out.get("quality", "normal")), _QUALITY_CELLS["normal"])
    return grid_for(int(out.get("width", 1080)), int(out.get("height", 1920)), cells)


class FluidSim:
    def __init__(self, h: int, w: int, dissipation: float, vel_dissipation: float,
                 viscosity: float, vorticity: float, wrap: bool = True,
                 dye_modes: list | None = None):
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
        self.X = xx.astype(np.float32)   # column index (0..w-1)
        self.Y = yy.astype(np.float32)   # row index (0..h-1)
        # Eigenvalues of the 5-point periodic Laplacian with per-axis periods
        # (h, w), so the spectral Poisson solve works on a rectangular grid.
        a = (4.0 - 2 * np.cos(2 * np.pi * np.arange(h) / h)[:, None]
             - 2 * np.cos(2 * np.pi * np.arange(w) / w)[None, :])
        a[0, 0] = 1.0
        self._poisson = a

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
        div = ((np.roll(self.u, -1, 1) - self.u) +
               (np.roll(self.v, -1, 0) - self.v))
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
        self.u -= (p - np.roll(p, 1, 1))
        self.v -= (p - np.roll(p, 1, 0))

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
        curl = ((np.roll(self.v, -1, 1) - np.roll(self.v, 1, 1)) -
                (np.roll(self.u, -1, 0) - np.roll(self.u, 1, 0))) * 0.5
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
            for fld in ("u", "v"):
                f = getattr(self, fld)
                setattr(self, fld, (f + k * (np.roll(f, 1, 0) + np.roll(f, -1, 0) +
                        np.roll(f, 1, 1) + np.roll(f, -1, 1))) / (1 + 4 * k))
        self._vorticity(self.vorticity)
        self._project(self._src)   # establish the radial outflow (if any source)
        self._src = None           # consume this frame's divergence source
        u0 = self._advect(self.u)
        v0 = self._advect(self.v)
        self.u, self.v = u0, v0
        self._project()            # clean up advection divergence (no source)
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


def apply_background(frames: np.ndarray, color) -> np.ndarray:
    """Composite uint8 dye-on-black `frames` over a solid `color` (hex or [r,g,b]).

    Uses the same emissive "screen" blend as `_tonemap`'s `bg`: black bg leaves the
    dye unchanged; a colour shows through where there's no dye and never darkens the
    glow. Used at the TERMINAL output so intermediate layers stay background-free and
    composite cleanly (spec 10)."""
    bg = _hex_rgb(color) if isinstance(color, str) else np.asarray(color, np.float32)
    f = frames.astype(np.float32) / 255.0
    out = 1.0 - (1.0 - bg[None, None, None, :]) * (1.0 - f)
    return (np.clip(out, 0, 1) * 255).astype(np.uint8)


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
    angle_s = _series(src.get("angle", 270.0), nframes)        # deg
    inten_s = _series(src.get("intensity", 1.0), nframes)
    opac_s = _series(src.get("opacity", 1.0), nframes)
    radial = bool(src.get("radial", False))
    enabled = bool(src.get("enabled", True))

    # Source position: a polyline the source travels across the clip (one point
    # = static). pts[k] in 0..1; param t in [0,1] over the whole duration.
    raw_pts = src.get("points") or [[0.5, 0.5]]
    pts = np.array([[float(a), float(b)] for a, b in raw_pts], np.float32)
    path_speed = float(src.get("path_speed", 1.0))     # traversals over the clip
    pingpong = bool(src.get("path_pingpong", False))
    closed = bool(src.get("path_closed", False)) and len(pts) > 2

    def pos_at(t):
        npts = len(pts)
        if npts == 1:
            return pts[0]
        ph = t * path_speed
        tri = 1.0 - abs((ph % 2.0) - 1.0) if pingpong else (ph % 1.0)
        if closed:                       # last point links back to the first
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
        px, py = pos_at(i / denom)
        ang = np.deg2rad(angle_s[i])
        color_i = np.array([r_s[i], g_s[i], b_s[i]], np.float32) * inten_s[i] * opac_s[i]
        sim.add_dye(px, py, radius_s[i], color_i, emit_s[i], layer)
        f = force_s[i] * 0.02  # slider units -> a few cells/frame at steady state
        if radial:
            # Radial uses a divergence source (own gain); it builds outflow over
            # frames, so it wants a smaller per-frame strength than a velocity kick.
            sim.add_radial(px, py, radius_s[i], force_s[i] * 0.05)
        elif f:
            sim.add_force(px, py, radius_s[i], np.cos(ang) * f, np.sin(ang) * f)

    return inject


def simulate(params: dict, apply_bg: bool = True) -> tuple:
    """Run the sim from a params dict -> (frames uint8 [T,h,w,3], fps, (h,w)).

    Grid: an `output` dict (width/height/quality) selects a rectangular grid via
    `grid_from_output`; otherwise the legacy square `grid` (FluidLab `/fluid`).

    Emitters: `params["sources"]` is a LIST of source dicts injected together into
    ONE field each frame (merge). A single `params["source"]` is the back-compat
    case (wrapped as `[source]`). The medium (`params["fluid"]`) is one shared set.

    `apply_bg`: when True (default) the project background is composited in (the
    standalone single-fluid / FluidLab path — unchanged). The combine executor passes
    `apply_bg=False` so intermediate layers stay dye-on-transparent and the TERMINAL
    output applies the background once (spec 10)."""
    out = params.get("output") or {}
    if out:
        gh, gw = grid_from_output(out)
        fps = int(out.get("fps", params.get("fps", 24)))
        bg_rgb = _hex_rgb(out.get("background", "#000000"))
    else:
        gh = gw = int(params.get("grid", 96))
        fps = int(params.get("fps", 24))
        bg_rgb = None
    duration = float(params.get("duration", 10))
    nframes = max(1, int(round(duration * fps)))
    fl = params.get("fluid", {})
    sources = params.get("sources") or [params.get("source", {})]

    # Per-source edge mode. Distinct modes become separate dye LAYERS that share the
    # ONE velocity field, so a merge of fluids with different `wrap` keeps each
    # component's dye behaviour (wraps vs escapes) while they still interact. The
    # velocity uses one mode: the common one if uniform, else periodic (a torus the
    # whole flow lives on). A single source -> one layer == the old behaviour.
    src_wrap = [bool(s.get("wrap", True)) for s in sources]
    distinct = sorted(set(src_wrap))                       # [True] / [False] / [False, True]
    dye_modes = ["wrap" if w else "constant" for w in distinct]
    vel_wrap = distinct[0] if len(distinct) == 1 else True
    src_layer = [distinct.index(w) for w in src_wrap]

    # Medium params -> per-frame series FIRST, so the sim can be seeded from frame 0
    # and a wired pulse (an array) doesn't blow up float() in the constructor. The
    # loop below overwrites these attributes each frame.
    diss_s = _series(fl.get("dissipation", 0.95), nframes)
    vdis_s = _series(fl.get("velocity_dissipation", 0.97), nframes)
    visc_s = _series(fl.get("viscosity", 0.0), nframes)
    vort_s = _series(fl.get("vorticity", 5.0), nframes)
    sim = FluidSim(
        gh, gw,
        dissipation=float(diss_s[0]),
        vel_dissipation=float(vdis_s[0]),
        viscosity=float(visc_s[0]),
        vorticity=float(vort_s[0]),
        wrap=vel_wrap,
        dye_modes=dye_modes,
    )
    emitters = list(zip([_emitter(s, nframes) for s in sources], src_layer))

    frames = np.empty((nframes, gh, gw, 3), np.uint8)
    denom = max(1, nframes - 1)
    bg = bg_rgb if apply_bg else None
    for i in range(nframes):
        # Medium params can change each frame -> set on the sim before stepping.
        # FluidSim.step() reads these attributes each call, so this Just Works.
        sim.dissipation = float(diss_s[i])
        sim.vel_dissipation = float(vdis_s[i])
        sim.viscosity = float(visc_s[i])
        sim.vorticity = float(vort_s[i])
        for inject, layer in emitters:
            inject(sim, i, denom, layer)
        sim.step()
        frames[i] = _tonemap(sim.current_dye(), bg=bg)
    return frames, fps, (gh, gw)


def render_mp4(frames: np.ndarray, fps: int, path: Path,
               out_w: int | None = None, out_h: int | None = None) -> None:
    """Encode RGB frames to a web-playable h264 mp4 via system ffmpeg.

    frames are [T, H, W, 3]. `out_w`/`out_h` set the encoded pixel size; they are
    chosen with the SAME aspect as the grid (the sim grid is derived from the
    output size), so the upscale is uniform — no stretch, no bars. Defaults to a
    512px square for the legacy `/fluid` (FluidLab) path.
    """
    h, w = int(frames.shape[1]), int(frames.shape[2])
    out_w = int(out_w) if out_w else 512
    out_h = int(out_h) if out_h else 512
    out_w -= out_w % 2                     # h264 yuv420p needs even dimensions
    out_h -= out_h % 2
    path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y", "-v", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(fps),
        "-i", "-",
        "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        "-vf", f"scale={out_w}:{out_h}:flags=neighbor",   # upscale crisply
        str(path),
    ]
    proc = subprocess.run(cmd, input=frames.tobytes(), capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode()[-2000:])


def params_hash(params: dict) -> str:
    return hashlib.sha1(json.dumps(params, sort_keys=True).encode()).hexdigest()[:16]


if __name__ == "__main__":
    import time
    p = {"duration": 10, "fps": 24, "grid": 96,
         "source": {"emit": 0.3, "radius": 0.08, "force": 20, "angle": 270,
                    "radial": False, "color": "#46b0ff", "enabled": True},
         "fluid": {"dissipation": 0.95, "velocity_dissipation": 0.97,
                   "viscosity": 0.0, "vorticity": 6.0}}
    t0 = time.time()
    frames, fps, n = simulate(p)
    t1 = time.time()
    render_mp4(frames, fps, Path("/tmp/fluid_test.mp4"))
    t2 = time.time()
    print(f"sim {t1 - t0:.2f}s ({len(frames)} frames @ {n}px), "
          f"encode {t2 - t1:.2f}s -> /tmp/fluid_test.mp4")
