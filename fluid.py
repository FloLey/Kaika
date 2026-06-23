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


def _hex_rgb(s: str) -> np.ndarray:
    s = (s or "#ffffff").lstrip("#")
    if len(s) != 6:
        s = "ffffff"
    return np.array([int(s[i:i + 2], 16) for i in (0, 2, 4)], np.float32) / 255.0


class FluidSim:
    def __init__(self, n: int, dissipation: float, vel_dissipation: float,
                 viscosity: float, vorticity: float):
        self.n = n
        self.dissipation = dissipation
        self.vel_dissipation = vel_dissipation
        self.viscosity = viscosity
        self.vorticity = vorticity
        self.u = np.zeros((n, n), np.float32)
        self.v = np.zeros((n, n), np.float32)
        self.dens = np.zeros((n, n, 3), np.float32)
        yy, xx = np.meshgrid(np.arange(n), np.arange(n), indexing="ij")
        self.X = xx.astype(np.float32)   # column index
        self.Y = yy.astype(np.float32)   # row index
        # Eigenvalues of the 5-point periodic Laplacian (for the spectral solve).
        a = (4.0 - 2 * np.cos(2 * np.pi * np.arange(n) / n)[:, None]
             - 2 * np.cos(2 * np.pi * np.arange(n) / n)[None, :])
        a[0, 0] = 1.0
        self._poisson = a

    def _gauss(self, px: float, py: float, radius: float) -> np.ndarray:
        rc = max(1.0, radius * self.n)
        cx, cy = px * self.n, py * self.n
        d2 = (self.X - cx) ** 2 + (self.Y - cy) ** 2
        return np.exp(-d2 / (2 * rc * rc)).astype(np.float32)

    def add_dye(self, px, py, radius, color, amount):
        g = self._gauss(px, py, radius)
        self.dens += (amount * g)[..., None] * color[None, None, :]

    def add_force(self, px, py, radius, fx, fy):
        g = self._gauss(px, py, radius)
        self.u += g * fx
        self.v += g * fy

    def add_radial(self, px, py, radius, strength):
        """Outward burst around the centre (omnidirectional jet)."""
        g = self._gauss(px, py, radius)
        dx = self.X - px * self.n
        dy = self.Y - py * self.n
        norm = np.sqrt(dx * dx + dy * dy) + 1e-3
        self.u += g * strength * (dx / norm)
        self.v += g * strength * (dy / norm)

    def _project(self):
        div = ((np.roll(self.u, -1, 1) - self.u) +
               (np.roll(self.v, -1, 0) - self.v))
        phat = -sfft.fft2(div, workers=-1) / self._poisson
        phat[0, 0] = 0.0
        p = np.real(sfft.ifft2(phat, workers=-1)).astype(np.float32)
        self.u -= (p - np.roll(p, 1, 1))
        self.v -= (p - np.roll(p, 1, 0))

    def _advect(self, field):
        bx = self.X - self.u
        by = self.Y - self.v
        coords = np.stack([by, bx])
        if field.ndim == 2:
            return map_coordinates(field, coords, order=1, mode="wrap")
        out = np.empty_like(field)
        for c in range(field.shape[2]):
            out[..., c] = map_coordinates(field[..., c], coords, order=1, mode="wrap")
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
        self._project()
        u0 = self._advect(self.u)
        v0 = self._advect(self.v)
        self.u, self.v = u0, v0
        self._project()
        self.dens = self._advect(self.dens)
        self.dens *= self.dissipation
        np.clip(self.dens, 0.0, 16.0, out=self.dens)
        self.u *= self.vel_dissipation
        self.v *= self.vel_dissipation
        # Stability net: cap speed (keeps advection sane) and kill any NaN/inf.
        vmax = self.n * 0.25
        np.clip(self.u, -vmax, vmax, out=self.u)
        np.clip(self.v, -vmax, vmax, out=self.v)
        np.nan_to_num(self.u, copy=False)
        np.nan_to_num(self.v, copy=False)


def _tonemap(d: np.ndarray, exposure=1.9, gamma=1.15) -> np.ndarray:
    ldr = 1.0 - np.exp(-exposure * np.clip(d, 0, None))
    ldr = np.clip(ldr, 0, 1) ** (1.0 / gamma)
    return (np.clip(ldr, 0, 1) * 255).astype(np.uint8)


def simulate(params: dict) -> tuple:
    """Run the sim from a params dict -> (frames uint8 [T,n,n,3], fps, n)."""
    n = int(params.get("grid", 96))
    fps = int(params.get("fps", 24))
    duration = float(params.get("duration", 10))
    nframes = max(1, int(round(duration * fps)))
    src = params.get("source", {})
    fl = params.get("fluid", {})

    sim = FluidSim(
        n,
        dissipation=float(fl.get("dissipation", 0.95)),
        vel_dissipation=float(fl.get("velocity_dissipation", 0.97)),
        viscosity=float(fl.get("viscosity", 0.0)),
        vorticity=float(fl.get("vorticity", 5.0)),
    )
    col = src.get("color", "#46b0ff")
    if isinstance(col, (list, tuple)):           # [r,g,b] in 0..1 (the 4-axis UI)
        color = np.asarray(col, np.float32)
    else:                                        # legacy hex string
        color = _hex_rgb(col)
    # intensity = brightness/HDR glow; opacity = how much it shows (see-through).
    color = color * float(src.get("intensity", 1.0)) * float(src.get("opacity", 1.0))
    emit = float(src.get("emit", 0.3))
    radius = float(src.get("radius", 0.08))
    force = float(src.get("force", 20.0))
    angle0 = float(src.get("angle", 270.0))
    rot_speed = float(src.get("rot_speed", 0.0))   # deg/s
    rot_accel = float(src.get("rot_accel", 0.0))   # deg/s^2
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

    frames = np.empty((nframes, n, n, 3), np.uint8)
    denom = max(1, nframes - 1)
    for i in range(nframes):
        if enabled:
            px, py = pos_at(i / denom)
            ts = i / fps
            ang = np.deg2rad(angle0 + rot_speed * ts + 0.5 * rot_accel * ts * ts)
            sim.add_dye(px, py, radius, color, emit)
            f = force * 0.02  # slider units -> a few cells/frame at steady state
            if radial:
                sim.add_radial(px, py, radius, f)
            elif f:
                sim.add_force(px, py, radius, np.cos(ang) * f, np.sin(ang) * f)
        sim.step()
        frames[i] = _tonemap(sim.dens)
    return frames, fps, n


def render_mp4(frames: np.ndarray, fps: int, path: Path) -> None:
    """Encode RGB frames to a web-playable h264 mp4 via system ffmpeg."""
    n = frames.shape[1]
    path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y", "-v", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{n}x{n}", "-r", str(fps),
        "-i", "-",
        "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        "-vf", "scale=512:512:flags=neighbor",   # upscale crisply for display
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
