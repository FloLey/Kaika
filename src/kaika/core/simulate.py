"""E2 — Fluid simulation v2.  score + recipe/project -> fluid frames + velocity.

A Jos-Stam style stable-fluids solver (incompressible Navier-Stokes) in pure
NumPy on a **rectangular** toroidal grid: exact FFT pressure projection,
MacCormack advection, fully deterministic (seed -> identical video), no GPU.

v2 replaces the hardcoded kick/hat/lookahead behavior with a declarative
runtime driven entirely by the recipe:

* **TriggerIndex** precomputes, per frame, which emitters fire with what
  magnitude (onsets, beat grid, continuous conditions, lookahead windows,
  timeline spawns; mute/unmute windows suppress).
* **Placement / Direction / Color** engines implement the recipe tables. Every
  random draw uses a *stateless* per-event RNG (seed, emitter, frame, k), so a
  window preview reproduces exactly what the full run does at the same frame.
* **ModulationEngine** routes audio signals into any numeric config leaf
  (absolute / add / scale), applied per frame after segment smoothing and
  timeline ``set`` windows.
* **Checkpoints** snapshot the full sim state (float32-exact) every few
  seconds so window previews warm up from the nearest checkpoint instead of
  cold-starting.

Determinism contract: two runs over the same range are bit-identical (same
seed -> same video, tested). A checkpoint-resumed window restores state
bit-exactly and replays the same spawns/colors/positions, but NumPy's
vectorized transcendentals round 1 ULP differently depending on heap
alignment, and the solver is chaotic — so a resumed window is *visually*
equivalent to the full run (statistically identical dynamics), not pixel-
identical. Final renders never use checkpoints.

Outputs, per run dir:
  fluid/%06d.png        RGB density frame (canvas resolution)
  velocity/%06d.npy     (H, W, 2) float32 velocity field (sim resolution)
  fluid_stats.json      per-frame kinetic energy + density (for E5 sync check)
"""
from __future__ import annotations

import copy
import json
import os
import zlib
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field as dc_field
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

import numpy as np
import cv2

try:                                    # multi-threaded FFT when available
    from scipy import fft as _sfft
except ImportError:                     # pragma: no cover
    _sfft = None

_FFT_WORKERS = max(1, (os.cpu_count() or 2) - 1)

from .score import Score
from .recipe import Recipe, resolve_path, _normalise_placement
from .timeline import resolve_directives

ProgressFn = Callable[[int, int], None]

CHECKPOINT_EVERY_S = 5.0


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def _hex_to_rgb(h: str) -> np.ndarray:
    h = (h or "#FFFFFF").lstrip("#")
    if len(h) < 6:
        h = (h + "FFFFFF")[:6]
    return np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)], np.float32)


def _centroid_x(centroid_hz: float) -> float:
    """Spectral centroid -> 0..1 on a log scale over 150..8000 Hz."""
    lo, hi = np.log10(150.0), np.log10(8000.0)
    return float(np.clip((np.log10(max(centroid_hz, 150.0)) - lo) / (hi - lo),
                         0.0, 1.0))


def _hsv_to_rgb(h: float, s: float, v: float) -> np.ndarray:
    arr = np.uint8([[[int((h % 1.0) * 179), int(np.clip(s, 0, 1) * 255),
                      int(np.clip(v, 0, 1) * 255)]]])
    rgb = cv2.cvtColor(arr, cv2.COLOR_HSV2RGB)[0, 0]
    return rgb.astype(np.float32) / 255.0


def _event_rng(seed: int, emitter_i: int, frame_i: int, k: int = 0
               ) -> np.random.Generator:
    """Stateless per-event RNG: the draw depends only on (seed, emitter,
    frame, k), never on simulation history — window previews and checkpoint
    resumes reproduce the full run's randomness exactly."""
    return np.random.default_rng(
        np.random.SeedSequence([seed & 0x7FFFFFFF, emitter_i, frame_i, k]))


def _emitter_salt(eid: str) -> int:
    return zlib.crc32(eid.encode("utf8")) & 0xFFFF


def _tonemap(hdr: np.ndarray, exposure: float, gamma: float) -> np.ndarray:
    mapped = 1.0 - np.exp(-exposure * np.clip(hdr, 0.0, None))
    return np.clip(mapped, 0.0, 1.0) ** (1.0 / max(gamma, 1e-3))


def _render_frame(density: np.ndarray, render_cfg: dict, bloom_auto_sigma: float
                  ) -> np.ndarray:
    """HDR density -> filmic tone-map + bloom over a dark field -> uint8 RGB."""
    bloom = render_cfg.get("bloom", {})
    ldr = _tonemap(density, float(render_cfg.get("exposure", 1.9)),
                   float(render_cfg.get("gamma", 1.15)))
    amount = float(bloom.get("amount", 0.65))
    if amount > 0:
        sigma = float(bloom.get("sigma", 0.0)) or bloom_auto_sigma
        bright = np.clip(ldr - float(bloom.get("threshold", 0.45)), 0.0, 1.0)
        ldr = ldr + amount * cv2.GaussianBlur(bright, (0, 0), sigmaX=sigma)
    bg = float(render_cfg.get("background", 0.04))
    out = bg + (1.0 - bg) * np.clip(ldr, 0.0, 1.0)
    return (np.clip(out, 0.0, 1.0) * 255).astype(np.uint8)


# ---------------------------------------------------------------------------
# Solver (rectangular toroidal grid)
# ---------------------------------------------------------------------------

def _gpu_modules():
    """(cupy, cupyx.scipy.ndimage) when CUDA is genuinely usable, else
    (None, None). The probe allocates on-device so a broken install fails
    here, not mid-render."""
    try:
        import cupy as cp
        from cupyx.scipy import ndimage as cnd
        float(cp.zeros(2).sum())            # force a real CUDA context
        return cp, cnd
    except Exception:
        return None, None


def _to_np(a):
    """Device -> host when needed (cupy arrays have .get())."""
    return a.get() if hasattr(a, "get") else a


class FluidSim:
    """Stable-fluids solver on an H x W toroidal grid.

    ``use_gpu=True`` runs the whole field state on CUDA via CuPy (advection
    through ``cupyx`` map_coordinates, FFT projection through cupy.fft) and
    falls back silently to NumPy when CuPy/CUDA is unavailable — check
    ``self.gpu`` to know what you got. GPU output is deterministic per
    machine but not bit-identical to the CPU path."""

    def __init__(self, shape: Tuple[int, int], dissipation: float,
                 viscosity: float, seed: int, vel_dissipation: float = 0.96,
                 use_gpu: bool = False):
        self.cp, self._cnd = (None, None)
        if use_gpu:
            self.cp, self._cnd = _gpu_modules()
        self.xp = self.cp if self.cp is not None else np
        self.gpu = self.xp is not np
        xp = self.xp
        h, w = int(shape[0]), int(shape[1])
        self.h, self.w = h, w
        self.short = min(h, w)
        self.dissipation = dissipation
        self.vel_dissipation = vel_dissipation
        self.viscosity = viscosity
        self.rng = np.random.default_rng(seed)
        self.u = xp.zeros((h, w), xp.float32)
        self.v = xp.zeros((h, w), xp.float32)
        self.density = xp.zeros((h, w, 3), xp.float32)
        ys, xs = xp.meshgrid(xp.arange(h), xp.arange(w), indexing="ij")
        self.xs = xs.astype(xp.float32)
        self.ys = ys.astype(xp.float32)
        # Eigenvalues of the 5-point Poisson operator (per-axis periods).
        iy = xp.arange(h)
        ix = xp.arange(w)
        a = (4.0 - 2 * xp.cos(2 * xp.pi * iy / h)[:, None]
             - 2 * xp.cos(2 * xp.pi * ix / w)[None, :])
        a[0, 0] = 1.0                       # guard DC; mean pressure is gauge-free
        self._poisson = a
        self._k3 = np.ones((3, 3), np.uint8)

    # ---- host transfers -----------------------------------------------------
    def density_cpu(self) -> np.ndarray:
        return _to_np(self.density)

    def velocity_cpu(self) -> np.ndarray:
        return _to_np(self.xp.stack([self.u, self.v], axis=-1)
                      ).astype(np.float32)

    def load_state(self, u: np.ndarray, v: np.ndarray,
                   density: np.ndarray) -> None:
        xp = self.xp
        self.u = xp.asarray(u, xp.float32)
        self.v = xp.asarray(v, xp.float32)
        self.density = xp.asarray(density, xp.float32)

    # ---- operators ---------------------------------------------------------
    def _advect(self, field, u, v, dt: float):
        """MacCormack advection (bilinear semi-Lagrangian + error correction)."""
        if self.gpu:
            return self._advect_gpu(field, u, v, dt)
        mx = (self.xs - dt * u).astype(np.float32)
        my = (self.ys - dt * v).astype(np.float32)
        fwd = cv2.remap(field, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)
        bx = (self.xs + dt * u).astype(np.float32)
        by = (self.ys + dt * v).astype(np.float32)
        back = cv2.remap(fwd, bx, by, cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)
        corrected = fwd + 0.5 * (field - back)
        hi = cv2.dilate(fwd, self._k3)
        lo = cv2.erode(fwd, self._k3)
        return np.clip(corrected, lo, hi).astype(np.float32)

    def _advect_gpu(self, field, u, v, dt: float):
        cp, cnd = self.cp, self._cnd

        def sample(f, yy, xx):
            coords = cp.stack([yy, xx])
            if f.ndim == 2:
                return cnd.map_coordinates(f, coords, order=1, mode="grid-wrap")
            return cp.stack(
                [cnd.map_coordinates(f[..., c], coords, order=1,
                                     mode="grid-wrap")
                 for c in range(f.shape[-1])], axis=-1)

        fwd = sample(field, self.ys - dt * v, self.xs - dt * u)
        back = sample(fwd, self.ys + dt * v, self.xs + dt * u)
        corrected = fwd + 0.5 * (field - back)
        size = (3, 3) if field.ndim == 2 else (3, 3, 1)
        hi = cnd.maximum_filter(fwd, size=size, mode="wrap")
        lo = cnd.minimum_filter(fwd, size=size, mode="wrap")
        return cp.clip(corrected, lo, hi).astype(cp.float32)

    def _project(self, iters: int = 0) -> None:
        """Exact incompressibility via a spectral Poisson solve (periodic).
        cupy.fft on GPU; scipy's multi-threaded FFT on CPU (numpy's is 1-core)."""
        xp = self.xp
        div = ((xp.roll(self.u, -1, 1) - self.u) +
               (xp.roll(self.v, -1, 0) - self.v))
        if self.gpu:
            p_hat = -xp.fft.fft2(div) / self._poisson
            p_hat[0, 0] = 0.0
            p = xp.real(xp.fft.ifft2(p_hat)).astype(xp.float32)
        elif _sfft is not None:
            p_hat = -_sfft.fft2(div, workers=_FFT_WORKERS) / self._poisson
            p_hat[0, 0] = 0.0
            p = np.real(_sfft.ifft2(p_hat, workers=_FFT_WORKERS)).astype(np.float32)
        else:
            p_hat = -np.fft.fft2(div) / self._poisson
            p_hat[0, 0] = 0.0
            p = np.real(np.fft.ifft2(p_hat)).astype(np.float32)
        self.u -= (p - xp.roll(p, 1, 1)).astype(xp.float32)
        self.v -= (p - xp.roll(p, 1, 0)).astype(xp.float32)

    def _vorticity_confine(self, eps: float, dt: float) -> None:
        if eps <= 0:
            return
        xp = self.xp
        curl = ((xp.roll(self.v, -1, 1) - xp.roll(self.v, 1, 1)) -
                (xp.roll(self.u, -1, 0) - xp.roll(self.u, 1, 0))) * 0.5
        absc = xp.abs(curl)
        gx = (xp.roll(absc, -1, 1) - xp.roll(absc, 1, 1)) * 0.5
        gy = (xp.roll(absc, -1, 0) - xp.roll(absc, 1, 0)) * 0.5
        norm = xp.sqrt(gx * gx + gy * gy) + 1e-5
        gx, gy = gx / norm, gy / norm
        self.u += eps * dt * (gy * curl)
        self.v += eps * dt * (-gx * curl)

    def add_force(self, fu, fv) -> None:
        self.u += self.xp.asarray(fu, self.xp.float32)
        self.v += self.xp.asarray(fv, self.xp.float32)

    def _gauss_patch(self, px: float, py: float, radius: float):
        """A Gaussian restricted to its 4-sigma window (toroidal): O(r^2)
        instead of O(H*W) per splat. Returns (g, iy, ix) index arrays; falls
        back to the full grid when the window wraps onto itself (duplicate
        indices would drop contributions with fancy-index +=)."""
        r = max(1.0, radius * self.short)
        cx, cy = px * self.w, py * self.h
        ext = int(np.ceil(4.0 * r))
        if 2 * ext + 1 >= self.h or 2 * ext + 1 >= self.w:
            d2 = (self.xs - cx) ** 2 + (self.ys - cy) ** 2
            g = np.exp(-d2 / (2 * r * r)).astype(np.float32)
            return g, None, None
        ys = np.arange(int(np.floor(cy)) - ext, int(np.floor(cy)) + ext + 1)
        xs = np.arange(int(np.floor(cx)) - ext, int(np.floor(cx)) + ext + 1)
        d2 = (((xs - cx) ** 2)[None, :] + ((ys - cy) ** 2)[:, None])
        g = np.exp(-d2 / (2 * r * r)).astype(np.float32)
        return g, ys % self.h, xs % self.w

    def add_dye(self, px: float, py: float, radius: float,
                color: np.ndarray, amount: float) -> None:
        xp = self.xp
        g, iy, ix = self._gauss_patch(px, py, radius)
        col = xp.asarray(color, xp.float32)
        if iy is None:
            self.density += (amount * g)[..., None] * col[None, None, :]
        else:
            g = xp.asarray(g, xp.float32)
            self.density[xp.ix_(xp.asarray(iy), xp.asarray(ix))] += \
                (amount * g)[..., None] * col[None, None, :]

    def add_force_at(self, x: float, y: float, radius: float,
                     fx: float, fy: float) -> None:
        xp = self.xp
        g, iy, ix = self._gauss_patch(x, y, radius)
        if iy is None:
            self.u += (g * fx).astype(xp.float32)
            self.v += (g * fy).astype(xp.float32)
        else:
            g = xp.asarray(g, xp.float32)
            sel = xp.ix_(xp.asarray(iy), xp.asarray(ix))
            self.u[sel] += (g * fx).astype(xp.float32)
            self.v[sel] += (g * fy).astype(xp.float32)

    def add_splat(self, px: float, py: float, radius: float, force: float,
                  color: np.ndarray, dir_angle: float,
                  force_gain: float = 0.04) -> None:
        xp = self.xp
        g, iy, ix = self._gauss_patch(px, py, radius)
        col = xp.asarray(color, xp.float32)
        vel = xp.asarray(g) * force * force_gain / self.short
        if iy is None:
            self.u += (vel * np.cos(dir_angle)).astype(xp.float32)
            self.v += (vel * np.sin(dir_angle)).astype(xp.float32)
            self.density += xp.asarray(g)[..., None] * col[None, None, :]
        else:
            sel = xp.ix_(xp.asarray(iy), xp.asarray(ix))
            self.u[sel] += (vel * np.cos(dir_angle)).astype(xp.float32)
            self.v[sel] += (vel * np.sin(dir_angle)).astype(xp.float32)
            self.density[sel] += xp.asarray(g)[..., None] * col[None, None, :]

    def step(self, dt: float, vort_eps: float, density_clamp: float = 12.0) -> None:
        xp = self.xp
        if self.viscosity > 0:
            k = self.viscosity
            self.u = (self.u + k * (xp.roll(self.u, 1, 0) + xp.roll(self.u, -1, 0) +
                      xp.roll(self.u, 1, 1) + xp.roll(self.u, -1, 1))) / (1 + 4 * k)
            self.v = (self.v + k * (xp.roll(self.v, 1, 0) + xp.roll(self.v, -1, 0) +
                      xp.roll(self.v, 1, 1) + xp.roll(self.v, -1, 1))) / (1 + 4 * k)
        self._vorticity_confine(vort_eps, dt)
        self._project()
        u0, v0 = self.u.copy(), self.v.copy()
        vel = xp.stack([self.u, self.v], axis=-1).astype(xp.float32)
        vel = self._advect(vel, u0, v0, dt)
        self.u = xp.ascontiguousarray(vel[..., 0])
        self.v = xp.ascontiguousarray(vel[..., 1])
        self._project()
        self.density = self._advect(self.density, self.u, self.v, dt)
        self.density *= self.dissipation
        xp.clip(self.density, 0.0, density_clamp, out=self.density)
        self.u *= self.vel_dissipation
        self.v *= self.vel_dissipation

    def kinetic_energy(self) -> float:
        return float(self.xp.mean(self.u ** 2 + self.v ** 2))

    def total_density(self) -> float:
        return float(self.xp.mean(self.density))


def _write_png(path: Path, rgb: np.ndarray) -> None:
    """cv2's PNG encoder at low compression: ~5x faster than PIL's default,
    and it runs on the writer pool, not the solver thread."""
    cv2.imwrite(str(path), cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR),
                [cv2.IMWRITE_PNG_COMPRESSION, 2])


def _curl_noise(gx: np.ndarray, gy: np.ndarray, t: float, scale: float):
    """Divergence-free ambient velocity from the curl of a moving potential."""
    sx = gx * 2 * np.pi * scale
    sy = gy * 2 * np.pi * scale
    psi = (np.sin(sx + t) * np.cos(sy * 1.3 - 0.7 * t)
           + 0.6 * np.sin(sx * 0.7 - 1.1 * t) * np.sin(sy * 1.7 + 0.5 * t)
           + 0.4 * np.sin(sx * 1.9 + 0.3 * t) * np.cos(sy * 0.9 - 0.6 * t))
    u = (np.roll(psi, -1, 0) - np.roll(psi, 1, 0)) * 0.5
    v = -(np.roll(psi, -1, 1) - np.roll(psi, 1, 1)) * 0.5
    peak = float(np.sqrt(u * u + v * v).max()) + 1e-6
    return (u / peak).astype(np.float32), (v / peak).astype(np.float32)


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------

@dataclass
class _Source:
    """A transient, directional dye source: born on a trigger event, it streams
    matter along its heading (jet + self-propulsion), then fades and dies."""
    x: float
    y: float
    color: List[float]
    radius: float
    emit: float
    life: int
    drift: float
    dx: float
    dy: float
    speed: float
    jet: float
    decay: float = 1.3
    expand: float = 0.8
    age: int = 0

    def to_state(self) -> list:
        return [self.x, self.y, list(self.color), self.radius, self.emit,
                self.life, self.drift, self.dx, self.dy, self.speed, self.jet,
                self.decay, self.expand, self.age]

    @staticmethod
    def from_state(s: list) -> "_Source":
        return _Source(x=s[0], y=s[1], color=list(s[2]), radius=s[3], emit=s[4],
                       life=int(s[5]), drift=s[6], dx=s[7], dy=s[8], speed=s[9],
                       jet=s[10], decay=s[11], expand=s[12], age=int(s[13]))


def _advance_sources(sim: FluidSim, sources: List[_Source]) -> List[_Source]:
    """Emit + propel every living source one step; return the survivors."""
    still: List[_Source] = []
    for s in sources:
        frac = s.age / s.life
        env = (1.0 - frac) ** max(s.decay, 0.0)
        r_now = s.radius * (1.0 + s.expand * frac)
        color = np.asarray(s.color, np.float32)
        sim.add_dye(s.x, s.y, r_now, color, s.emit * env)
        sim.add_force_at(s.x, s.y, r_now, s.dx * s.jet * env, s.dy * s.jet * env)
        xi = int(np.clip(s.x * sim.w, 0, sim.w - 1))
        yi = int(np.clip(s.y * sim.h, 0, sim.h - 1))
        s.x = (s.x + (s.speed * s.dx + s.drift * float(sim.u[yi, xi])) / sim.w) % 1.0
        s.y = (s.y + (s.speed * s.dy + s.drift * float(sim.v[yi, xi])) / sim.h) % 1.0
        s.age += 1
        if s.age < s.life:
            still.append(s)
    return still


# ---------------------------------------------------------------------------
# Signals
# ---------------------------------------------------------------------------

def _signal_array(score: Score, name: str, n: int) -> np.ndarray:
    """A named per-frame signal as a 0..1 array over n frames."""
    frames = score.frames
    name = (name or "rms").strip()

    def per_frame(fn):
        return np.array([fn(frames[i]) if i < len(frames) else 0.0
                         for i in range(n)], np.float64)

    if name == "rms":
        return per_frame(lambda f: f.rms)
    if name == "centroid":
        return per_frame(lambda f: _centroid_x(f.centroid_hz))
    if name == "flux":
        return per_frame(lambda f: f.flux)
    if name == "beat_phase":
        return per_frame(lambda f: f.beat_phase)
    if name == "bar_phase":
        return per_frame(lambda f: f.bar_phase)
    if name == "harmonic_ratio":
        return per_frame(lambda f: f.harmonic_ratio)
    if name == "chroma_argmax":
        return per_frame(lambda f: f.chroma_argmax / 11.0)
    if name.startswith("band."):
        idx = {"low": 0, "mid": 1, "high": 2}.get(name.split(".", 1)[1], 0)
        return per_frame(lambda f: f.bands[idx] if len(f.bands) > idx else 0.0)
    if name == "voice":
        # Sustained vocal/melodic presence: harmonic energy in the mid band,
        # weighted by overall loudness, normalized to the track's own peak.
        raw = per_frame(lambda f: (f.bands[1] if len(f.bands) > 1 else 0.0)
                        * f.harmonic_ratio * f.rms)
        peak = float(raw.max())
        return raw / peak if peak > 1e-9 else raw
    if name == "section.energy":
        fps = score.audio.fps
        out = np.zeros(n)
        for sec in score.sections:
            f0 = max(0, int(sec.start * fps))
            f1 = min(n, int(sec.end * fps) + 1)
            out[f0:f1] = sec.energy
        return out
    if name.startswith("lookahead"):
        # lookahead(label, seconds): tension ramp before matching sections.
        inner = name[name.find("(") + 1:name.rfind(")")] if "(" in name else "drop, 8"
        parts = [p.strip() for p in inner.split(",")]
        label = parts[0] or "drop"
        window = float(parts[1]) if len(parts) > 1 else 8.0
        fps = score.audio.fps
        out = np.zeros(n)
        for sec in score.sections:
            if sec.label != label:
                continue
            for i in range(n):
                dt = sec.start - i / fps
                if 0 <= dt <= window:
                    out[i] = max(out[i], 1.0 - dt / window)
        return out
    return np.zeros(n)


def _held_argmax(score: Score, n: int, min_hold_s: float) -> np.ndarray:
    """chroma_argmax through a hold window: the new dominant pitch class must
    persist ``min_hold_s`` before the output switches (anti-strobe)."""
    fps = score.audio.fps
    hold = max(1, int(round(min_hold_s * fps)))
    raw = np.array([score.frames[i].chroma_argmax if i < len(score.frames) else 0
                    for i in range(n)], int)
    out = raw.copy()
    if n == 0:
        return out
    current = raw[0]
    cand, cand_run = raw[0], 0
    for i in range(n):
        if raw[i] == current:
            cand_run = 0
        elif raw[i] == cand:
            cand_run += 1
            if cand_run >= hold:
                current = cand
                cand_run = 0
        else:
            cand, cand_run = raw[i], 1
        out[i] = current
    return out


# ---------------------------------------------------------------------------
# Trigger index
# ---------------------------------------------------------------------------

@dataclass
class _Spawn:
    emitter_i: int            # index into recipe.emitters; -1 = inline timeline
    mag: float
    k: int                    # per-frame ordinal for stateless RNG
    overrides: dict = dc_field(default_factory=dict)  # placement/color/body/count


def _cond(when: str, sig_cache: Dict[str, np.ndarray], score: Score, n: int,
          i: int) -> bool:
    """Evaluate a continuous trigger condition like 'rms > 0.5'."""
    if not when:
        return True
    for op in (">=", "<=", ">", "<"):
        if op in when:
            name, val = when.split(op, 1)
            name = name.strip()
            if name not in sig_cache:
                sig_cache[name] = _signal_array(score, name, n)
            x = sig_cache[name][i]
            v = float(val)
            return {"<": x < v, ">": x > v, "<=": x <= v, ">=": x >= v}[op]
    return True


def build_trigger_index(score: Score, recipe: Recipe, n_frames: int,
                        timeline: Optional[List[dict]] = None
                        ) -> Tuple[List[List[_Spawn]], List[str]]:
    """Precompute, for every frame, the spawns that fire (with magnitude and
    overrides). Knowing the whole track up front is what makes palette cycling
    and window previews exact."""
    fps = score.audio.fps
    by_frame: List[List[_Spawn]] = [[] for _ in range(n_frames)]
    warnings: List[str] = []
    sig_cache: Dict[str, np.ndarray] = {}

    directives, tl_warnings = resolve_directives(timeline or [], score)
    warnings.extend(tl_warnings)

    # Mute windows per emitter id: list of (t_on, t_off) intervals.
    mutes: Dict[str, List[List[float]]] = {}
    for d in sorted([d for d in directives if d["action"] in ("mute", "unmute")],
                    key=lambda d: d["t"]):
        eid = d.get("emitter", "")
        if d["action"] == "mute":
            mutes.setdefault(eid, []).append([d["t"], float("inf")])
        else:
            spans = mutes.get(eid)
            if spans and spans[-1][1] == float("inf"):
                spans[-1][1] = d["t"]

    def muted(eid: str, t: float) -> bool:
        return any(a <= t < b for a, b in mutes.get(eid, []))

    for ei, em in enumerate(recipe.emitters):
        if not em.enabled:
            continue
        trig = em.trigger
        if trig.type == "onset":
            for e in score.onsets.get(trig.band, []):
                if e.mag < trig.min_mag:
                    continue
                fi = int(round(e.t * fps))
                if 0 <= fi < n_frames and not muted(em.id, e.t):
                    per_frame = [s for s in by_frame[fi] if s.emitter_i == ei]
                    if trig.max_per_frame and len(per_frame) >= trig.max_per_frame:
                        continue
                    by_frame[fi].append(_Spawn(ei, e.mag, len(by_frame[fi])))
        elif trig.type == "beat":
            every = max(1, int(trig.every))
            for bi, b in enumerate(score.beats):
                if (bi - trig.offset) % every != 0 or b.mag < trig.min_mag:
                    continue
                fi = int(round(b.t * fps))
                if 0 <= fi < n_frames and not muted(em.id, b.t):
                    by_frame[fi].append(_Spawn(ei, b.mag, len(by_frame[fi])))
        elif trig.type == "continuous":
            step = max(1, int(trig.every_frames))
            mag_sig = None
            if trig.mag_source:
                if trig.mag_source not in sig_cache:
                    sig_cache[trig.mag_source] = _signal_array(
                        score, trig.mag_source, n_frames)
                mag_sig = sig_cache[trig.mag_source]
            for fi in range(0, n_frames, step):
                t = fi / fps
                if muted(em.id, t):
                    continue
                if trig.section:
                    sec = next((s for s in score.sections
                                if s.start <= t < s.end), None)
                    if sec is None or sec.label != trig.section:
                        continue
                if not _cond(trig.when, sig_cache, score, n_frames, fi):
                    continue
                mag = float(mag_sig[fi]) if mag_sig is not None else 1.0
                if mag < trig.min_mag:          # gate weak frames out
                    continue
                by_frame[fi].append(_Spawn(ei, mag, len(by_frame[fi])))
        elif trig.type == "lookahead":
            label = trig.section or "drop"
            step = max(1, int(trig.every_frames))
            window = max(1e-6, float(trig.window_s))
            hit = False
            for sec in score.sections:
                if sec.label != label:
                    continue
                hit = True
                f_start = int(max(0.0, sec.start - window) * fps)
                f_end = min(n_frames, int(sec.start * fps))
                for fi in range(f_start, f_end, step):
                    t = fi / fps
                    boost = 1.0 - (sec.start - t) / window
                    if boost > 0 and not muted(em.id, t):
                        by_frame[fi].append(_Spawn(ei, boost, len(by_frame[fi])))
            if not hit and any(s.label for s in score.sections):
                warnings.append(f"emitter '{em.id}': lookahead section "
                                f"'{label}' not found in this track")
        # "manual": timeline only.

    # Timeline spawns.
    ids = {e.id: i for i, e in enumerate(recipe.emitters)}
    for d in directives:
        if d["action"] != "spawn":
            continue
        fi = int(round(d["t"] * fps))
        if not (0 <= fi < n_frames):
            warnings.append(f"timeline spawn at {d['t']:.2f}s is outside the "
                            "rendered range — skipped")
            continue
        eid = d.get("emitter", "")
        ei = ids.get(eid, -1)
        if eid and ei < 0:
            warnings.append(f"timeline spawn: unknown emitter '{eid}' — using "
                            "an inline default source")
        overrides = {k: d[k] for k in ("placement", "color", "body", "count")
                     if k in d}
        by_frame[fi].append(_Spawn(ei, float(d.get("mag", 1.0)),
                                   len(by_frame[fi]), overrides))
    return by_frame, warnings


# ---------------------------------------------------------------------------
# Placement / direction / color
# ---------------------------------------------------------------------------

def _place(p: dict, count: int, frame_i: int, rng: np.random.Generator,
           signals: Dict[str, float]) -> Tuple[List[Tuple[float, float]],
                                               Tuple[float, float]]:
    """Positions for ``count`` sources + the reference center (for radial
    directions). All coordinates normalized 0..1 per axis."""
    typ = p.get("type", "random")
    jitter = float(p.get("jitter", 0.0))
    pts: List[Tuple[float, float]] = []
    center = (0.5, 0.5)

    if typ == "fixed":
        base = p.get("points") or [[0.5, 0.5]]
        for k in range(count):
            x, y = base[k % len(base)]
            pts.append((float(x), float(y)))
        center = tuple(np.mean(np.array(base), axis=0))
    elif typ == "wander":
        c = p.get("center", [0.5, 0.5])
        amp = float(p.get("wander_amp", 0.16))
        freq = float(p.get("wander_freq", 1.0))
        wc = (c[0] + amp * np.sin(frame_i * 0.045 * freq),
              c[1] + amp * np.cos(frame_i * 0.037 * freq))
        center = (float(wc[0]), float(wc[1]))
        jit = float(p.get("jitter", 0.09))
        for _ in range(count):
            xy = np.clip(np.array(wc) + rng.normal(0, jit, 2), 0.03, 0.97)
            pts.append((float(xy[0]), float(xy[1])))
        jitter = 0.0
    elif typ == "random":
        r = p.get("region", [0.05, 0.05, 0.95, 0.95])
        for _ in range(count):
            pts.append((float(rng.uniform(r[0], r[2])),
                        float(rng.uniform(r[1], r[3]))))
        center = ((r[0] + r[2]) / 2, (r[1] + r[3]) / 2)
    elif typ == "line":
        base = p.get("points") or [[0.25, 0.5], [0.75, 0.5]]
        a, b = np.array(base[0], float), np.array(base[1], float)
        ws = [0.5] if count == 1 else list(np.linspace(0.0, 1.0, count))
        for wgt in ws:
            xy = a + (b - a) * wgt
            pts.append((float(xy[0]), float(xy[1])))
        center = tuple((a + b) / 2)
    elif typ == "circle":
        c = p.get("center", [0.5, 0.5])
        rad = float(p.get("radius", 0.25))
        arc = np.deg2rad(float(p.get("arc_deg", 360.0)))
        n = max(1, count)
        angles = (np.arange(n) / n * arc if arc >= 2 * np.pi - 1e-6
                  else np.linspace(0, arc, n))
        for a in angles:
            pts.append((float(c[0] + rad * np.cos(a)),
                        float(c[1] + rad * np.sin(a))))
        center = (float(c[0]), float(c[1]))
    elif typ == "grid":
        rows = max(1, int(p.get("rows", 2)))
        cols = max(1, int(p.get("cols", 2)))
        r = p.get("region", [0.1, 0.1, 0.9, 0.9])
        lattice = [(r[0] + (r[2] - r[0]) * (c + 0.5) / cols,
                    r[1] + (r[3] - r[1]) * (rw + 0.5) / rows)
                   for rw in range(rows) for c in range(cols)]
        for k in range(count):
            pts.append(lattice[k % len(lattice)])
        center = ((r[0] + r[2]) / 2, (r[1] + r[3]) / 2)
    elif typ in ("signal_x", "signal_y"):
        rng_lo, rng_hi = p.get("range", [0.1, 0.9])
        sig = float(signals.get(p.get("source", "rms"), 0.0))
        val = rng_lo + sig * (rng_hi - rng_lo)
        for _ in range(count):
            if typ == "signal_x":
                pts.append((float(val), float(p.get("y", 0.5))))
            else:
                pts.append((float(p.get("x", 0.5)), float(val)))
        center = pts[0]
    else:
        pts = [(0.5, 0.5)] * count

    if jitter > 0:
        pts = [tuple(np.clip(np.array(xy) + rng.normal(0, jitter, 2),
                             0.02, 0.98)) for xy in pts]
    return pts, (float(center[0]), float(center[1]))


def _direction(d: dict, pos: Tuple[float, float], center: Tuple[float, float],
               rng: np.random.Generator, sim: FluidSim) -> float:
    typ = d.get("type", "radial_out")
    jit = float(d.get("jitter", 0.0))
    if typ in ("radial_out", "radial_in"):
        ang = float(np.arctan2(pos[1] - center[1], pos[0] - center[0]))
        if not np.isfinite(ang) or (pos[0] == center[0] and pos[1] == center[1]):
            ang = float(rng.uniform(0, 2 * np.pi))
        if typ == "radial_in":
            ang += np.pi
    elif typ == "fixed":
        ang = float(np.deg2rad(d.get("angle_deg", 0.0)))
    elif typ == "flow":
        xi = int(np.clip(pos[0] * sim.w, 0, sim.w - 1))
        yi = int(np.clip(pos[1] * sim.h, 0, sim.h - 1))
        u, v = float(sim.u[yi, xi]), float(sim.v[yi, xi])
        ang = (float(np.arctan2(v, u)) if (abs(u) + abs(v)) > 1e-6
               else float(rng.uniform(0, 2 * np.pi)))
    else:  # random
        ang = float(rng.uniform(0, 2 * np.pi))
    if jit > 0:
        ang += float(rng.normal(0, jit))
    return ang


def _palette_lerp(palette: List[np.ndarray], x: float) -> np.ndarray:
    if len(palette) == 1:
        return palette[0]
    x = float(np.clip(x, 0.0, 1.0)) * (len(palette) - 1)
    i = int(np.floor(x))
    j = min(i + 1, len(palette) - 1)
    w = x - i
    return (1 - w) * palette[i] + w * palette[j]


class _ColorEngine:
    """Resolves an emitter's color spec for one spawn. Palette cycling uses a
    per-emitter counter precomputed from the full trigger index, so window
    previews see the same cycle position as the full run."""

    def __init__(self, palettes: Dict[str, List[str]], score: Score, n: int):
        self.palettes = {k: [_hex_to_rgb(c) for c in v]
                         for k, v in palettes.items()}
        self.score = score
        self.n = n
        self._held: Dict[float, np.ndarray] = {}

    def held_pitch(self, frame_i: int, min_hold_s: float) -> int:
        key = round(min_hold_s, 3)
        if key not in self._held:
            self._held[key] = _held_argmax(self.score, self.n, min_hold_s)
        return int(self._held[key][min(frame_i, self.n - 1)])

    def palette(self, name: str) -> List[np.ndarray]:
        return self.palettes.get(name) or [_hex_to_rgb("#B84A74")]

    def resolve(self, c: dict, frame_i: int, cycle_idx: int,
                rng: np.random.Generator) -> np.ndarray:
        typ = c.get("type", "palette")
        pal = self.palette(c.get("palette", "main"))
        if typ == "fixed":
            color = _hex_to_rgb(c.get("hex", "#FFFFFF"))
        elif typ == "palette":
            color = pal[int(c.get("index", 0)) % len(pal)]
        elif typ == "palette_cycle":
            start = int(c.get("start", 1))
            sub = pal[start:] or pal
            color = sub[cycle_idx % len(sub)]
        elif typ == "palette_random":
            color = pal[int(rng.integers(0, len(pal)))]
        elif typ == "chroma_hue":
            pitch = self.held_pitch(frame_i, float(c.get("min_hold_s", 0.2)))
            hue = pitch / 12.0 + float(c.get("hue_offset", 0.0)) / 360.0
            color = _hsv_to_rgb(hue, float(c.get("saturation", 0.7)),
                                float(c.get("value", 0.9)))
        elif typ == "chroma_palette":
            pitch = self.held_pitch(frame_i, float(c.get("min_hold_s", 0.2)))
            color = _palette_lerp(pal, pitch / 11.0)
        elif typ == "centroid_ramp":
            fr = self.score.frames[min(frame_i, len(self.score.frames) - 1)]
            x = _centroid_x(fr.centroid_hz)
            color = ((1 - x) * _hex_to_rgb(c.get("dark", "#1B2740"))
                     + x * _hex_to_rgb(c.get("bright", "#FFE3B0")))
        else:
            color = pal[0]

        b = c.get("brightness") or {}
        src = b.get("source", "fixed")
        if src == "fixed":
            mul = float(b.get("value", 1.0))
        else:
            lo, hi = b.get("range", [0.75, 1.25])
            fr = self.score.frames[min(frame_i, len(self.score.frames) - 1)]
            x = _centroid_x(fr.centroid_hz) if src == "centroid" else fr.rms
            mul = lo + x * (hi - lo)
        return (color * mul * float(c.get("opacity", 1.0))).astype(np.float32)


# ---------------------------------------------------------------------------
# Modulation engine
# ---------------------------------------------------------------------------

def _curve_fn(spec: str):
    s = (spec or "linear").strip()
    if s == "linear":
        return lambda x: x
    if s == "smoothstep":
        return lambda x: x * x * (3 - 2 * x)
    if s.startswith("pow(") and s.endswith(")"):
        k = float(s[4:-1])
        return lambda x: np.clip(x, 0.0, 1.0) ** k
    if s.startswith("step(") and s.endswith(")"):
        t = float(s[5:-1])
        return lambda x: 1.0 if x >= t else 0.0
    return lambda x: x


def _smooth(arr: np.ndarray, smooth_s: float, fps: int) -> np.ndarray:
    """One-pole low-pass, precomputed over the whole track so window previews
    see the identical smoothed signal."""
    if smooth_s <= 0 or len(arr) == 0:
        return arr
    alpha = 1.0 - np.exp(-1.0 / max(smooth_s * fps, 1e-6))
    out = np.empty_like(arr)
    acc = arr[0]
    for i, x in enumerate(arr):
        acc += alpha * (x - acc)
        out[i] = acc
    return out


class ModulationEngine:
    def __init__(self, recipe: Recipe, score: Score, n_frames: int):
        fps = score.audio.fps
        self.mods = []
        for m in recipe.modulators:
            sig = _smooth(np.clip(_signal_array(score, m.source, n_frames),
                                  0.0, 1.0), m.smooth_s, fps)
            lo, hi = (m.range + [0.0, 1.0])[:2]
            self.mods.append((m.target, sig, float(lo), float(hi),
                              m.mode, _curve_fn(m.curve)))

    def apply(self, tree: dict, frame_i: int) -> None:
        for target, sig, lo, hi, mode, curve in self.mods:
            hit = resolve_path(tree, target)
            if hit is None:
                continue
            parent, key = hit
            base = parent[key]
            if not isinstance(base, (int, float)) or isinstance(base, bool):
                continue
            x = float(curve(float(sig[min(frame_i, len(sig) - 1)])))
            mapped = lo + x * (hi - lo)
            if mode == "add":
                parent[key] = base + mapped
            elif mode == "scale":
                parent[key] = base * mapped
            else:
                parent[key] = mapped


# ---------------------------------------------------------------------------
# Checkpoints
# ---------------------------------------------------------------------------

def structural_hash(recipe: Recipe) -> str:
    """Changes here invalidate checkpoints: grid shape, emitter list shape,
    seed. Plain numeric edits keep checkpoints (warm-up absorbs the drift)."""
    h, w = recipe.canvas.grid()
    key = json.dumps({"grid": [h, w], "seed": recipe.seed,
                      "emitters": [e.id for e in recipe.emitters]})
    return f"{zlib.crc32(key.encode()):08x}"


class CheckpointStore:
    def __init__(self, dir_: str | Path):
        self.dir = Path(dir_)

    def save(self, frame_i: int, sim: FluidSim, sources: List[_Source],
             t_phase: float, struct: str) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        meta = {"frame": frame_i, "t_phase": t_phase, "struct": struct,
                "sources": [s.to_state() for s in sources]}
        # float32 throughout: the nonlinear advection amplifies fp16 density
        # error over a resume; exact state keeps window previews bit-faithful.
        np.savez_compressed(
            self.dir / f"{frame_i:06d}.npz",
            u=_to_np(sim.u).astype(np.float32),
            v=_to_np(sim.v).astype(np.float32),
            density=_to_np(sim.density).astype(np.float32),
            meta=np.frombuffer(json.dumps(meta).encode(), dtype=np.uint8))

    def nearest(self, frame_i: int, struct: str) -> Optional[dict]:
        """The latest checkpoint at or before ``frame_i`` matching the
        structural hash, or None."""
        if not self.dir.is_dir():
            return None
        best = None
        for p in sorted(self.dir.glob("*.npz")):
            try:
                fi = int(p.stem)
            except ValueError:
                continue
            if fi <= frame_i:
                best = p
        if best is None:
            return None
        try:
            data = np.load(best)
            meta = json.loads(bytes(data["meta"]).decode())
            if meta.get("struct") != struct:
                return None
            return {"frame": meta["frame"], "t_phase": meta["t_phase"],
                    "sources": [_Source.from_state(s) for s in meta["sources"]],
                    "u": data["u"].astype(np.float32),
                    "v": data["v"].astype(np.float32),
                    "density": data["density"].astype(np.float32)}
        except Exception:
            return None

    def clear(self) -> None:
        if self.dir.is_dir():
            for p in self.dir.glob("*.npz"):
                p.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Main entry
# ---------------------------------------------------------------------------

@dataclass
class SimResult:
    fluid_dir: Path
    velocity_dir: Path
    stats_path: Path
    n_frames: int
    grid: Tuple[int, int]               # (h, w) simulation cells
    render_size: Tuple[int, int]        # (h, w) output pixels
    warnings: List[str] = dc_field(default_factory=list)

    # Back-compat: a few callers/tests still read a single number.
    @property
    def resolution(self) -> int:
        return self.render_size[1]


def simulate(score: Score, recipe: Recipe, out_dir: str | Path,
             max_frames: Optional[int] = None,
             progress: Optional[ProgressFn] = None,
             frame_trees: Optional[List[dict]] = None,
             timeline: Optional[List[dict]] = None,
             render_range: Optional[tuple] = None,
             warmup_frames: int = 0,
             write_velocity: bool = True,
             draft_cap: Optional[int] = None,
             checkpoints: Optional[CheckpointStore] = None,
             save_checkpoints: bool = False,
             gpu: Optional[bool] = None) -> SimResult:
    """Run the fluid sim.

    ``frame_trees`` (one config tree per frame, from ``Project.frame_trees``)
    carries segment overrides + timeline ``set`` windows; modulators are applied
    here, per frame, on top. ``timeline`` is the resolved-directive source for
    spawns/mutes. ``render_range=(f0, f1)`` simulates only that window — warmed
    up either from the nearest matching checkpoint or ``warmup_frames`` of
    unrendered lead-in. ``draft_cap`` caps the *render* short side (the sim grid
    is capped by the caller via the recipe).

    Frame encoding/IO runs on a small thread pool: PNG encode was ~60% of the
    wall clock when done inline on the solver thread.
    """
    out_dir = Path(out_dir)
    fluid_dir = out_dir / "fluid"
    vel_dir = out_dir / "velocity"
    fluid_dir.mkdir(parents=True, exist_ok=True)
    if write_velocity:
        vel_dir.mkdir(parents=True, exist_ok=True)

    fps = score.audio.fps
    n_frames = score.n_frames if max_frames is None else min(score.n_frames,
                                                             max_frames)
    grid_h, grid_w = recipe.canvas.grid()
    struct = structural_hash(recipe)

    spawns_by_frame, warnings = build_trigger_index(score, recipe, n_frames,
                                                    timeline)
    mod_engine = ModulationEngine(recipe, score, n_frames)
    color_engine = _ColorEngine(recipe.palettes, score, n_frames)

    # Per-emitter cumulative spawn counts (exact palette cycling in windows).
    n_emitters = len(recipe.emitters)
    cum = np.zeros((n_frames + 1, n_emitters), np.int64)
    for fi in range(n_frames):
        cum[fi + 1] = cum[fi]
        for sp in spawns_by_frame[fi]:
            if sp.emitter_i >= 0:
                cum[fi + 1][sp.emitter_i] += 1

    # Window + warm-up resolution.
    if render_range is not None:
        render_start = max(0, int(render_range[0]))
        sim_end = min(n_frames, int(render_range[1]))
        sim_start = max(0, render_start - max(0, warmup_frames))
    else:
        render_start, sim_start, sim_end = 0, 0, n_frames

    base_field = recipe.to_dict()["field"]
    want_gpu = (gpu if gpu is not None
                else os.environ.get("KAIKA_GPU", "") == "1")
    sim = FluidSim((grid_h, grid_w), base_field["dissipation"],
                   base_field["viscosity"], recipe.seed,
                   vel_dissipation=base_field["velocity_dissipation"],
                   use_gpu=want_gpu)
    if want_gpu and not sim.gpu:
        warnings.append("KAIKA_GPU=1 but CuPy/CUDA is unavailable — "
                        "running on CPU (pip install cupy-cuda12x)")
    sources: List[_Source] = []
    t_phase = sim_start * float(base_field["ambient"]["speed"])

    if checkpoints is not None and render_range is not None:
        # A checkpoint holds the state *after* its frame's step, so resuming
        # continues at frame+1; it must sit strictly before the render window.
        ck = checkpoints.nearest(render_start - 1, struct)
        if ck is not None:
            # Exact state always beats an approximate cold-start warm-up,
            # even when the checkpoint sits earlier than the warm-up window.
            sim.load_state(ck["u"], ck["v"], ck["density"])
            sources = ck["sources"]
            t_phase = ck["t_phase"]
            sim_start = int(ck["frame"]) + 1

    rh, rw = recipe.canvas.render_size(cap_short=draft_cap)
    gx = sim.xs / grid_w
    gy = sim.ys / grid_h
    bloom_auto_sigma = max(1.0, min(grid_h, grid_w) / 48)
    dt = 1.0
    stats = {"kinetic_energy": [], "total_density": []}
    emitters_d = [json.loads(json.dumps(recipe.to_dict()["emitters"][i]))
                  for i in range(n_emitters)]
    seed = int(recipe.seed)

    ckpt_every = max(1, int(CHECKPOINT_EVERY_S * fps))
    total_steps = max(1, sim_end - sim_start)
    # Writer pool: PNG encode + .npy dumps run off the solver thread. The
    # try/finally guarantees the pool drains even on cancellation (the job
    # queue cancels by raising through the progress callback).
    writer = ThreadPoolExecutor(max_workers=min(4, os.cpu_count() or 2))
    pending: List = []
    try:
        for step_i, i in enumerate(range(sim_start, sim_end)):
            tree = copy.deepcopy(frame_trees[i]) if frame_trees is not None else {
                "field": copy.deepcopy(base_field),
                "render": json.loads(json.dumps(recipe.to_dict()["render"])),
                "emitters": {e["id"]: copy.deepcopy(e) for e in emitters_d},
            }
            mod_engine.apply(tree, i)
            fld = tree["field"]
            rnd = tree["render"]
            sim.dissipation = float(fld.get("dissipation", 0.90))
            sim.vel_dissipation = float(fld.get("velocity_dissipation", 0.96))
            sim.viscosity = float(fld.get("viscosity", 0.0))
            force_gain = float(fld.get("force_gain", 0.04))

            fdata = score.frames[i] if i < len(score.frames) else score.frames[-1]
            frame_signals = {
                "rms": fdata.rms, "centroid": _centroid_x(fdata.centroid_hz),
                "flux": fdata.flux, "beat_phase": fdata.beat_phase,
                "bar_phase": fdata.bar_phase, "harmonic_ratio": fdata.harmonic_ratio,
                "chroma_argmax": fdata.chroma_argmax / 11.0,
                "band.low": fdata.bands[0] if fdata.bands else 0.0,
                "band.mid": fdata.bands[1] if len(fdata.bands) > 1 else 0.0,
                "band.high": fdata.bands[2] if len(fdata.bands) > 2 else 0.0,
            }

            # Ambient stirring (strength is typically RMS-modulated by a default
            # modulator; the engine itself has no hidden audio coupling).
            amb = fld.get("ambient", {})
            ua, va = _curl_noise(gx, gy, t_phase, float(amb.get("scale", 2.6)))
            amp = float(amb.get("strength", 1.6))
            sim.add_force(ua * amp, va * amp)
            t_phase += float(amb.get("speed", 0.16))

            # Spawns.
            cycle_base = {ei: int(cum[i][ei]) for ei in range(n_emitters)}
            cycle_seen: Dict[int, int] = {}
            for sp in spawns_by_frame[i]:
                if sp.emitter_i >= 0:
                    ecfg = tree["emitters"].get(recipe.emitters[sp.emitter_i].id)
                    if ecfg is None:
                        continue
                    ecfg = (json.loads(json.dumps(ecfg)) if sp.overrides else ecfg)
                    for k in ("placement", "color", "body"):
                        if k in sp.overrides:
                            ov = sp.overrides[k] or {}
                            if k == "placement":
                                # A placement override switches behavior wholesale
                                # (line vs wander share no params), so it replaces.
                                ecfg[k] = _normalise_placement(dict(ov))
                            else:
                                ecfg[k] = {**ecfg.get(k, {}), **ov}
                    count = int(sp.overrides.get("count", ecfg.get("count", 1)))
                    salt = _emitter_salt(recipe.emitters[sp.emitter_i].id)
                else:
                    ecfg = _inline_emitter(sp.overrides)
                    count = int(sp.overrides.get("count", 1))
                    salt = 0xBEEF
                rng = _event_rng(seed + salt, max(sp.emitter_i, 0), i, sp.k)
                pts, center = _place(ecfg.get("placement", {}), max(1, count), i,
                                     rng, frame_signals)
                body = ecfg.get("body", {})
                mag_gain = float(body.get("mag_gain", 1.0))
                mag = 0.5 + sp.mag * mag_gain
                if sp.emitter_i >= 0:
                    seen = cycle_seen.get(sp.emitter_i, 0)
                    cycle_idx = cycle_base[sp.emitter_i] + seen
                    cycle_seen[sp.emitter_i] = seen + 1
                else:
                    cycle_idx = 0
                color = color_engine.resolve(ecfg.get("color", {}), i, cycle_idx, rng)
                for pos in pts:
                    ang = _direction(ecfg.get("direction", {}), pos, center, rng, sim)
                    _spawn_source(sim, sources, pos, ang, color, body, mag,
                                  force_gain, fps)

            sources = _advance_sources(sim, sources)

            vort = float(fld.get("vorticity", 8.0)) * float(
                fld.get("vorticity_gain", 0.015))
            sim.step(dt, vort, float(fld.get("density_clamp", 12.0)))

            if save_checkpoints and checkpoints is not None and i % ckpt_every == 0:
                checkpoints.save(i, sim, sources, t_phase, struct)

            if i >= render_start:
                frame = _render_frame(sim.density_cpu(), rnd, bloom_auto_sigma)
                if frame.shape[:2] != (rh, rw):
                    frame = cv2.resize(frame, (rw, rh),
                                       interpolation=cv2.INTER_LINEAR)
                pending.append(writer.submit(
                    _write_png, fluid_dir / f"{i - render_start:06d}.png", frame))
                if write_velocity:
                    vel = sim.velocity_cpu()
                    pending.append(writer.submit(
                        np.save, vel_dir / f"{i - render_start:06d}.npy", vel))
                # Backpressure: each pending task pins a frame in memory; if
                # the solver outruns the disk, block on the oldest write so
                # in-flight work stays bounded (and errors surface early).
                while len(pending) >= 16:
                    pending.pop(0).result()
                stats["kinetic_energy"].append(round(sim.kinetic_energy(), 6))
                stats["total_density"].append(round(sim.total_density(), 6))
            if progress:
                progress(step_i + 1, total_steps)

    finally:
        writer.shutdown(wait=True)
    for f in pending:                   # surface any IO/encode error
        f.result()

    stats_path = out_dir / "fluid_stats.json"
    stats_path.write_text(json.dumps(stats))
    return SimResult(fluid_dir=fluid_dir, velocity_dir=vel_dir,
                     stats_path=stats_path,
                     n_frames=max(0, sim_end - render_start),
                     grid=(grid_h, grid_w), render_size=(rh, rw),
                     warnings=warnings)


def _inline_emitter(overrides: dict) -> dict:
    """A one-off timeline spawn with no named emitter: sane defaults +
    whatever the directive specifies."""
    base = {
        "placement": {"type": "fixed", "points": [[0.5, 0.5]]},
        "direction": {"type": "random", "jitter": 0.0},
        "color": {"type": "fixed", "hex": "#FFFFFF"},
        "body": {"radius": 0.1, "force": 6000.0, "lifetime_s": 0.8,
                 "emit": 0.2, "drift": 0.5, "speed": 1.2},
    }
    if "placement" in overrides:
        base["placement"] = _normalise_placement(dict(overrides["placement"] or {}))
    for k in ("color", "body"):
        if k in overrides:
            base[k] = {**base[k], **(overrides[k] or {})}
    return base


def _spawn_source(sim: FluidSim, sources: List[_Source],
                  pos: Tuple[float, float], angle: float, color: np.ndarray,
                  body: dict, mag: float, force_gain: float, fps: int) -> None:
    """Birth a directional source: an initial jet along ``angle`` + ongoing
    directional emission, so matter streams away instead of pooling."""
    dx, dy = float(np.cos(angle)), float(np.sin(angle))
    impulse = float(body.get("force", 6000.0)) * force_gain / sim.short * mag
    sim.add_force_at(pos[0], pos[1], float(body.get("radius", 0.08)),
                     dx * impulse, dy * impulse)
    sources.append(_Source(
        x=pos[0], y=pos[1], color=[float(c) for c in color],
        radius=float(body.get("radius", 0.08)),
        emit=float(body.get("emit", 0.2)) * mag,
        life=max(1, int(float(body.get("lifetime_s", 0.5)) * fps)),
        drift=float(body.get("drift", 0.4)),
        dx=dx, dy=dy, speed=float(body.get("speed", 1.5)),
        jet=float(body.get("jet_fraction", 0.35)) * impulse,
        decay=float(body.get("decay", 1.3)),
        expand=float(body.get("expand", 0.8))))
