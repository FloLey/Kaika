"""Look FX — pure pixel math for the style cards (specs/look-fx/).

Frame ops on `(T, H, W, C)` uint8 arrays, C in {3, 4} (an RGBA layer's alpha rides
along, the `_transform_frames` convention). No Dag import — `graph_render.py` wraps
these in thin `_xxx_video` / `_xxx_block` handlers, so the whole-clip path and the
block-streamed path run the SAME code and stay byte-identical (both feed the same
`output_hash` mp4 cache). Every apply function therefore takes the block's absolute
frame offset where it matters; modulatable params arrive as per-frame float32 arrays
(`Dag._fx_params` output) already sliced to the block.
"""

from __future__ import annotations

import numpy as np


def echo_scan(
    frames: np.ndarray,
    acc: np.ndarray | None,
    fps: int,
    mode: str = "ghost",
    *,
    length: np.ndarray,
    amount: np.ndarray,
) -> tuple[np.ndarray, np.ndarray | None]:
    """Motion trails, two flavours of decayed memory mixed back into the frame.

    `ghost` (default): the accumulator is an exponential moving average of the past —
    every CHANGE leaves a fading afterimage, whatever the contrast (a dark runner on a
    bright street ghosts just as well as a bright fluid on black). The classic echo
    for real footage. Its blend is capped at 50/50 so the live frame always stays
    readable — `amount` = 1 is the balanced echo, not a full long-exposure smear.

    `bright`: the accumulator is a decayed running MAX — only bright-on-dark content
    trails, at its original brightness (no greying), and black stays black, so the
    dye floor survives. Comet tails for fluids and anything glowing on black.

    `dark`: the exact mirror of `bright` (the same scan on the inverted image) — only
    dark-on-bright content trails, and the subject itself stays fully solid. Shadow
    trails for a dark figure on a bright scene. (On an RGBA layer the alpha channel is
    inverted along with the colour — dark mode is meant for full-frame footage.)

    Per frame i: `p = 0.5 ** (1 / (length[i]·fps))` (`length` = the trail's half-life
    in seconds), the accumulator folds the frame in, and the output lerps the frame
    toward the trail by `amount[i]`. All channels trail — an RGBA layer's cut-out
    ghosts too.

    `acc` is the carried float32 accumulator (None at the clip start); the caller
    keeps the returned one across blocks. Because decay folds every past frame into
    it, carrying `acc` IS the exact whole-history scan in O(1) memory — no upstream
    lookback needed (blocks can't re-pull earlier frames).
    """
    if mode == "dark":
        # bright's scan in inverted space; `acc` is carried inverted too (opaque to
        # callers), and the fast path below returns inverted last frames consistently.
        out, acc = echo_scan(255 - frames, acc, fps, "bright", length=length, amount=amount)
        return 255 - out, acc
    if not np.any(length * fps > 1e-6):
        # length = 0 throughout the block: p = 0 collapses both accumulators onto the
        # current frame, so every output equals its input and acc = the block's last
        # frame — return exactly that so a modulated length switching on in a LATER
        # block sees the same acc the full scan would.
        return frames, frames[-1].astype(np.float32)
    out = np.empty_like(frames)
    if acc is None:
        # ghost: seed with the first frame (an empty history must not dim frame 0);
        # bright: seed with black (max against 0 is the frame itself).
        acc = (
            frames[0].astype(np.float32)
            if mode == "ghost"
            else np.zeros(frames.shape[1:], np.float32)
        )
    for i in range(len(frames)):
        f = frames[i].astype(np.float32)
        lf = float(length[i]) * fps
        p = 0.5 ** (1.0 / lf) if lf > 1e-6 else 0.0
        if mode == "ghost":
            acc = f + (acc - f) * p  # exponential moving average of the past
            delta = (acc - f) * 0.5  # signed, capped 50/50: the live frame stays readable
        else:
            np.maximum(f, acc * p, out=acc)  # decayed running max
            delta = np.clip(acc - f, 0.0, 255.0)  # trails only ever ADD light
        out[i] = np.clip(f + delta * float(amount[i]), 0.0, 255.0).astype(np.uint8)
    return out, acc


# --------------------------------------------------------------------------- #
# Color Grade (specs/look-fx/02-color-grade.md)
# --------------------------------------------------------------------------- #
# OpenCV colormap ids for the thermal mode, resolved lazily (cv2 import guarded the
# way _extract_apply does). applyColorMap returns BGR — every LUT below is flipped
# to RGB once at build time.
_THERMAL_MAPS = ("turbo", "inferno", "jet", "ocean")
_thermal_lut_cache: dict[str, np.ndarray] = {}


def _cv2():
    try:
        import cv2
    except ImportError as e:  # pragma: no cover
        raise RuntimeError(
            "the Color Grade card needs opencv — `pip install -r requirements.txt`"
        ) from e
    return cv2


def _thermal_lut(name: str) -> np.ndarray:
    """The 256×3 RGB lookup table for one colormap (built once, cached)."""
    lut = _thermal_lut_cache.get(name)
    if lut is None:
        cv2 = _cv2()
        cmap = getattr(cv2, f"COLORMAP_{name.upper()}", cv2.COLORMAP_TURBO)
        ramp = np.arange(256, dtype=np.uint8).reshape(1, 256)
        lut = cv2.applyColorMap(ramp, cmap)[0][:, ::-1].copy()  # BGR -> RGB
        _thermal_lut_cache[name] = lut
    return lut


def _rotate_hue(rgb: np.ndarray, turns: float) -> np.ndarray:
    """Rotate a single RGB colour (0..1 triple) around the hue wheel by `turns` (0..1)."""
    if turns <= 1e-6:
        return rgb
    import colorsys

    h, s, v = colorsys.rgb_to_hsv(*(float(c) for c in rgb))
    return np.array(colorsys.hsv_to_rgb((h + turns) % 1.0, s, v), np.float32)


def _luminance(rgb: np.ndarray) -> np.ndarray:
    """(T,H,W,3) uint8 -> (T,H,W) float32 luminance, 0..255 (Rec.601 weights)."""
    return (
        rgb[..., 0] * np.float32(0.299)
        + rgb[..., 1] * np.float32(0.587)
        + rgb[..., 2] * np.float32(0.114)
    )


def colorgrade_apply(
    frames: np.ndarray,
    mode: str,
    cmap: str,
    color_a: np.ndarray,
    color_b: np.ndarray,
    fps: int,
    frame_offset: int,
    *,
    intensity: np.ndarray,
    shift: np.ndarray,
) -> np.ndarray:
    """Recolour `frames` (T,H,W,C) uint8, C in {3,4} — an RGBA layer's alpha passes
    through untouched (only the colour is graded).

    thermal — luminance through a 256-entry colormap LUT, rolled by `shift`·255;
    `intensity` mixes dry ↔ graded. Floor note: inferno keeps black ~black, turbo /
    jet / ocean lift it (their 0 is coloured) — grade modes belong at the END of the
    chain (Docs say so).
    duotone — shaped luminance (`gamma = 2^(shift·2−1)`) lerps `color_a` → `color_b`;
    lifts the floor by design (`color_a` IS the shadow colour).
    neon — Canny edges + a Gaussian halo × `intensity`, coloured `color_b` with its
    hue rotated by `shift`, on black. Black stays black.

    `color_a` is a static (3,) 0..1 triple; `color_b` is a PER-FRAME (T,3) 0..1 array
    (the wired `tint` colour card, else the static swatch tiled) — so a gradient tint
    with a bound `position` sweeps the grade's colour with the music.
    """
    t, h, w, c = frames.shape
    rgb = frames[..., :3]
    out = np.empty_like(frames)
    if c == 4:
        out[..., 3] = frames[..., 3]
    lum = _luminance(rgb)  # (T,H,W) float32 0..255

    if mode == "thermal":
        lut = _thermal_lut(cmap)
        idx = lum.astype(np.uint8)
        for i in range(t):
            roll = int(round(float(shift[i]) * 255.0)) % 256
            graded = lut[(idx[i].astype(np.int16) + roll) % 256]  # (H,W,3) uint8
            k = np.float32(intensity[i])
            out[i, ..., :3] = (
                rgb[i].astype(np.float32) * (1 - k) + graded.astype(np.float32) * k
            ).astype(np.uint8)
        return out

    if mode == "duotone":
        for i in range(t):
            gamma = 2.0 ** (float(shift[i]) * 2.0 - 1.0)
            shaped = (lum[i] / 255.0) ** np.float32(gamma)  # (H,W) 0..1
            graded = (
                color_a * 255.0 * (1.0 - shaped[..., None]) + color_b[i] * 255.0 * shaped[..., None]
            )
            k = np.float32(intensity[i])
            out[i, ..., :3] = np.clip(
                rgb[i].astype(np.float32) * (1 - k) + graded * k, 0, 255
            ).astype(np.uint8)
        return out

    # neon: edge core + halo on black, coloured (optionally hue-rotated) color_b.
    cv2 = _cv2()
    sigma = max(1.5, h * 0.008)
    for i in range(t):
        edges = cv2.Canny(np.ascontiguousarray(lum[i].astype(np.uint8)), 80, 160)
        core = edges.astype(np.float32) / 255.0
        halo = cv2.GaussianBlur(core, (0, 0), sigma) * 2.5 * float(intensity[i])
        val = np.clip(core + halo, 0.0, 1.0)
        colour = _rotate_hue(color_b[i], float(shift[i]))
        out[i, ..., :3] = (val[..., None] * colour * 255.0).astype(np.uint8)
    return out
