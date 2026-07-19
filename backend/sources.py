"""Non-fluid video SOURCE cards (spec 04): -> dye layers for the compositor.

These synthesise a video stream from scratch (no fluid sim) so they can be layered with
fluids via a stack combine or sent straight to an output. The `lyrics` card returns an
RGBA layer `(T, H, W, 4)` — its alpha is the glyph+outline coverage, so a black outline
truly occludes the fluid beneath it (`graph.composite` / `fluid.flatten` both honour a
4-channel layer's alpha). `SOURCE_PARAMS` mirrors the modulatable ranges in
lib/nodeParams.ts; the box/outline/font are static `data` fields.
"""

from __future__ import annotations

import json
import subprocess
from functools import lru_cache

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.ndimage import gaussian_filter

from . import fonts as _fonts, procgen
from .animation_params import SOURCE_PARAM_SPEC

# key -> (min, max, default) per source card — the executor's compact view, derived
# from the rich spec in animation_params (which also generates the frontend table,
# so the UI [lo, hi] can never drift from what the render maps).
SOURCE_PARAMS: dict[str, dict[str, tuple[float, float, float]]] = {
    card: {p["key"]: (p["min"], p["max"], p["default"]) for p in spec}
    for card, spec in SOURCE_PARAM_SPEC.items()
}


@lru_cache(maxsize=256)
def _load(path: str, px: int):
    return ImageFont.truetype(path, px)


def _font(px: int, key: str | None = None):
    """The chosen bundled TrueType font at `px` (cached). Falls back to the default
    bundled font, then to PIL's default so a render never crashes on a bad key."""
    px = max(8, int(px))
    for k in (key, _fonts.default_key()):
        path = _fonts.font_path(k)
        if path:
            try:
                return _load(path, px)
            except OSError:
                continue
    try:
        return ImageFont.load_default(px)  # PIL >= 10 scalable default
    except (TypeError, AttributeError):
        return ImageFont.load_default()


def _wrap(text: str, font, max_w: float, draw) -> list[str]:
    """Greedy word-wrap `text` into lines no wider than `max_w` (a lone over-long word
    keeps its own line; auto-fit shrinks the font until even that fits)."""
    lines: list[str] = []
    cur = ""
    for word in text.split():
        trial = f"{cur} {word}".strip()
        if not cur or draw.textlength(trial, font=font) <= max_w:
            cur = trial
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines or [""]


def _fit(text, key, px0, box_w, box_h, draw, stroke_frac):
    """Shrink the font from `px0` until the wrapped text block — INCLUDING its outline
    stroke — actually fits inside the box (both width and height). Measured with PIL's
    own `multiline_textbbox` (which accounts for `stroke_width`) so the fit matches what
    `multiline_text` draws — otherwise the stroke makes the text overflow. Returns
    (font, px, block, stroke_px, spacing, bbox)."""
    px = max(8, int(px0))
    while True:
        font = _font(px, key)
        sw = max(0, int(stroke_frac * px))
        spacing = max(0, int(px * 0.15))  # gap between wrapped lines
        # Wrap to the width left after the stroke eats `sw` px on each side.
        lines = _wrap(text, font, box_w - 2 * sw, draw)
        block = "\n".join(lines)
        bbox = draw.multiline_textbbox((0, 0), block, font=font, spacing=spacing, stroke_width=sw)
        if px <= 8 or (bbox[2] - bbox[0] <= box_w and bbox[3] - bbox[1] <= box_h):
            return font, px, block, sw, spacing, bbox
        px = max(8, int(px * 0.9) if px > 24 else px - 1)


def _at(v, i):
    """Index a per-frame array, or pass a scalar through (outline colour defaults)."""
    return v[i] if hasattr(v, "__len__") else v


# Render the text layer at >= this short side (then downscale to the sim grid), so the
# wrap/auto-fit is resolution-independent and matches the card preview. On a coarse sim
# grid (e.g. 64px in draft) the box is a few pixels tall and text can't fit / wraps wildly.
_TEXT_MIN = 640


def _text_res(h: int, w: int) -> tuple[int, int]:
    """A text-render (th, tw) for a target grid (h, w): the same aspect with the short side
    raised to at least `_TEXT_MIN`. Returns (h, w) unchanged when already large enough."""
    short = min(h, w)
    if short <= 0 or short >= _TEXT_MIN:
        return h, w
    s = _TEXT_MIN / short
    return max(1, int(round(h * s))), max(1, int(round(w * s)))


def lyrics(
    nframes,
    h,
    w,
    fps,
    *,
    lines,
    seg_start,
    align,
    case,
    reveal,
    r,
    g,
    b,
    opacity,
    font="inter",
    box_x=0.05,
    box_y=0.08,
    box_w=0.9,
    box_h=0.84,
    outline=True,
    outline_width=0.12,
    outline_r=0.0,
    outline_g=0.0,
    outline_b=0.0,
    frame_offset=0,
) -> np.ndarray:
    """Render the segment's aligned lyric lines as a timed RGBA dye layer. `lines`
    = [{t0, t1, text}] in ABSOLUTE song time; `seg_start` offsets each frame into the
    clip. With reveal="word" the active line fills in word-by-word over its [t0, t1].

    Text word-wraps and auto-shrinks to fill the box (`box_x/y/w/h`, fractions 0..1) —
    the box defines both size and placement — and is centred vertically within it;
    `align` justifies horizontally. `outline` draws a stroke (width = `outline_width` *
    font px, colour `outline_r/g/b`, default black) under the fill (colour `r/g/b`,
    default white) so the text stays readable over anything — the returned alpha covers
    both and the stroke is always opaque so it occludes the fluid whatever colour it is.

    `frame_offset` is the absolute clip-frame index of the FIRST rendered frame, so the
    block renderer can synthesize just frames [frame_offset, frame_offset+nframes) while
    the per-frame `r/g/b/opacity` arrays are the matching sliced ranges."""
    out = np.zeros((nframes, h, w, 4), np.uint8)  # RGBA: alpha = glyph+outline coverage
    if not lines:
        return out
    dt = 1.0 / float(fps or 24)
    # Draw at a resolution-independent size (>= _TEXT_MIN short side), then downscale each
    # frame to the sim grid (h, w) — so placement/wrapping match the card preview.
    th, tw = _text_res(h, w)
    resize = (th, tw) != (h, w)
    bx, by = int(box_x * tw), int(box_y * th)
    bw, bh = max(1, int(box_w * tw)), max(1, int(box_h * th))
    # The fitted layout depends only on the (post-case) line text — the box, font and
    # stroke are constant for the whole call — so solve each distinct line ONCE instead
    # of re-running the shrink loop every frame (a 10s@30fps clip hits ~300 frames).
    fits: dict[str, tuple] = {}
    wraps: dict[tuple[str, str], str] = {}  # word-reveal blocks, keyed (line, shown)
    for i in range(nframes):
        t = seg_start + (frame_offset + i) * dt
        line = next(
            (ln for ln in lines if float(ln.get("t0", 0)) <= t < float(ln.get("t1", 0))), None
        )
        if line is None:
            continue
        text = str(line.get("text", "")).strip()
        if not text:
            continue
        if case == "upper":
            text = text.upper()
        elif case == "lower":
            text = text.lower()
        img = Image.new("RGBA", (tw, th), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        # Fit the font to the FULL line (stroke included) so word-reveal fills a FIXED
        # layout instead of rescaling/reflowing the already-shown words every frame.
        fit = fits.get(text)
        if fit is None:
            fit = fits[text] = _fit(text, font, bh, bw, bh, draw, outline_width if outline else 0.0)
        fnt, px, full_block, sw, spacing, bbox = fit
        if reveal == "word":
            words = text.split()
            t0 = float(line.get("t0", 0.0))
            t1 = max(t0 + 0.1, float(line.get("t1", t0 + 1.0)))
            frac = max(0.0, min(1.0, (t - t0) / (t1 - t0)))
            shown = " ".join(words[: max(1, int(np.ceil(frac * len(words))))])
            block = wraps.get((text, shown))
            if block is None:  # same breaks as the full line
                block = wraps[text, shown] = "\n".join(_wrap(shown, fnt, bw - 2 * sw, draw))
        else:
            block = full_block
        fill = (int(r[i] * 255), int(g[i] * 255), int(b[i] * 255), 255)
        # Outline stays fully opaque (alpha 255) so it keeps occluding the fluid whatever
        # its colour; only the RGB is customisable (defaults to black).
        stroke = (
            int(_at(outline_r, i) * 255),
            int(_at(outline_g, i) * 255),
            int(_at(outline_b, i) * 255),
            255,
        )

        block_w, block_h = bbox[2] - bbox[0], bbox[3] - bbox[1]
        if align == "left":
            x0 = bx
        elif align == "right":
            x0 = bx + bw - block_w
        else:
            x0 = bx + (bw - block_w) // 2
        y0 = by + (bh - block_h) // 2  # centred vertically in the box
        draw.multiline_text(
            (x0 - bbox[0], y0 - bbox[1]),
            block,
            font=fnt,
            fill=fill,
            spacing=spacing,
            align=align,
            stroke_width=sw,
            stroke_fill=stroke,
        )

        if resize:
            img = img.resize((w, h), Image.BILINEAR)  # text-res -> sim grid
        arr = np.asarray(img, np.uint8).copy()
        op = float(opacity[i])
        if op < 1.0:
            arr[..., 3] = (arr[..., 3].astype(np.float32) * op).astype(np.uint8)
        out[i] = arr
    return out


# --------------------------------------------------------------------------- #
# Image / Video layer cards (spec: backgrounds are layers, not a setting)
# --------------------------------------------------------------------------- #
def _place_box(w: int, h: int, box_x, box_y, box_w, box_h):
    """Pixel box (x0, y0, bw, bh) for a fractional placement box, clamped in-frame.
    Defaults (0,0,1,1) cover the whole frame."""
    bw = max(1, int(round(float(box_w) * w)))
    bh = max(1, int(round(float(box_h) * h)))
    x0 = max(0, min(int(round(float(box_x) * w)), w - 1))
    y0 = max(0, min(int(round(float(box_y) * h)), h - 1))
    return x0, y0, min(bw, w - x0), min(bh, h - y0)


def _fit_rgba(src: np.ndarray, bw: int, bh: int, fit: str) -> np.ndarray:
    """Resize a source RGBA (H,W,4) into a (bh,bw,4) box: `cover` fills + centre-crops,
    `contain` fits inside on a transparent letterbox, `stretch` distorts to exact size."""
    ih, iw = src.shape[:2]
    pil = Image.fromarray(src, "RGBA")
    if fit == "stretch" or iw == 0 or ih == 0:
        return np.asarray(pil.resize((bw, bh), Image.LANCZOS), np.uint8)
    scale = max(bw / iw, bh / ih) if fit == "cover" else min(bw / iw, bh / ih)
    nw, nh = max(1, round(iw * scale)), max(1, round(ih * scale))
    r = np.asarray(pil.resize((nw, nh), Image.LANCZOS), np.uint8)
    out = np.zeros((bh, bw, 4), np.uint8)
    ox, oy = (nw - bw) // 2, (nh - bh) // 2  # >0 crop (cover), <0 pad (contain)
    sx, sy, dx, dy = max(0, ox), max(0, oy), max(0, -ox), max(0, -oy)
    cw, ch = min(nw - sx, bw - dx), min(nh - sy, bh - dy)
    out[dy : dy + ch, dx : dx + cw] = r[sy : sy + ch, sx : sx + cw]
    return out


def _apply_opacity(base_rgba: np.ndarray, nframes: int, opacity) -> np.ndarray:
    """Broadcast a single (h,w,4) layer to (nframes,h,w,4), scaling alpha per frame."""
    h, w = base_rgba.shape[:2]
    op = np.asarray(opacity, np.float32).reshape(-1)[:, None, None]
    out = np.empty((nframes, h, w, 4), np.uint8)
    out[..., :3] = base_rgba[..., :3]
    out[..., 3] = np.clip(base_rgba[None, ..., 3].astype(np.float32) * op, 0, 255).astype(np.uint8)
    return out


def backdrop(nframes, h, w, *, r, g, b, opacity, frame_offset=0) -> np.ndarray:
    """A full-frame solid-colour RGBA layer `(nframes, h, w, 4)`. `r/g/b` are per-frame
    0..1 colour arrays (from the card's colour swatch); `alpha = 255 × opacity`, so the
    whole frame is an OPAQUE background layer for the bottom of a stack combine. A scalar
    broadcasts. `frame_offset` is unused (kept so the block renderer calls it like the
    other source cards)."""
    out = np.empty((nframes, h, w, 4), np.uint8)
    for arr, ch in ((r, 0), (g, 1), (b, 2)):
        v = np.clip(np.asarray(arr, np.float32).reshape(-1) * 255.0, 0, 255).astype(np.uint8)
        out[..., ch] = v[:, None, None]
    a = np.clip(np.asarray(opacity, np.float32).reshape(-1) * 255.0, 0, 255).astype(np.uint8)
    out[..., 3] = a[:, None, None]
    return out


# ── Generative simulation cards (docs/generative-cards/) ──────────────────────
# waves / lightning / aurora / rain / clouds are real 2-D simulations (fire
# rides the fluid solver — see fluid.FireSim). Shared contract:
#
#   - every card takes `layers`: a list of layer dicts, one per merged card —
#     {port arrays at FULL segment length, "seed", "stops", optional "points"}.
#     A single card passes just its own; a combine(merge) passes one per input
#     and the physics genuinely shares ONE field (wave heights superpose, drops
#     ripple the same surface, bolts light the same sky, cloud densities shade
#     under one sun). Surface/render params that must be single-valued for a
#     shared medium (depth, shading, opacity...) read from layers[0] — the
#     first merged card wins (documented in the UI).
#   - port arrays are indexed by ABSOLUTE frame (`frame_offset + i`) and speeds
#     integrate cumulatively, so a streamed block [a:b] matches the whole clip
#     bit-for-bit and modulated speeds stay smooth.
#   - `base` (waves / rain): optional upstream frames — the image the water
#     refracts. None -> the card renders onto its palette instead.


def _rgba(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Pack a float (h, w, 3) rgb + (h, w) alpha (both 0..1) into a uint8 RGBA frame."""
    out = np.empty(rgb.shape[:2] + (4,), np.uint8)
    out[..., :3] = np.clip(rgb * 255.0, 0, 255).astype(np.uint8)
    out[..., 3] = np.clip(alpha * 255.0, 0, 255).astype(np.uint8)
    return out


def _clock(port, fps: float) -> np.ndarray:
    """Integrate a per-frame rate port into elapsed sim time (s): the phase
    clock a speed-modulated simulation must use so audio-driven speed changes
    glide instead of jumping (phase = ∫speed·dt, never speed·t)."""
    v = np.asarray(port, np.float32).reshape(-1)
    return np.cumsum(v) / max(fps, 1e-6)


def _norm3(x: float, y: float, z: float) -> np.ndarray:
    v = np.asarray([x, y, z], np.float32)
    return v / max(float(np.hypot(np.hypot(v[0], v[1]), v[2])), 1e-6)


def _spec_pos(spec: dict, t: float) -> tuple[float, float]:
    """Sample an emitter-source SPEC's position at clip-normalised time `t` —
    mirrors fluid._emitter's path machinery (polyline + path_speed +
    pingpong/closed), so pattern / animate-points cards move the sim cards'
    origins exactly like they move fluid emitters."""
    pts = spec.get("points") or [[0.5, 0.5]]
    n = len(pts)
    if n == 1:
        return float(pts[0][0]), float(pts[0][1])
    ph = t * float(spec.get("path_speed", 0.0) or 0.0)
    tri = 1.0 - abs((ph % 2.0) - 1.0) if spec.get("path_pingpong") else (ph % 1.0)
    if spec.get("path_closed") and n > 2:
        s = tri * n
        k = int(s) % n
        fr = s - int(s)
        a, b = pts[k], pts[(k + 1) % n]
    else:
        s = tri * (n - 1)
        k = min(n - 2, int(s))
        fr = s - k
        a, b = pts[k], pts[k + 1]
    return (
        float(a[0]) * (1.0 - fr) + float(b[0]) * fr,
        float(a[1]) * (1.0 - fr) + float(b[1]) * fr,
    )


def _spec_gate(spec: dict, t: float) -> float:
    """The chase-gate factor of a spec at clip-normalised time `t` (1 = lit) —
    an animate-points "chase" sweeps WHICH origins are active."""
    gs = float(spec.get("gate_speed", 0.0) or 0.0)
    gd = float(spec.get("gate_duty", 1.0))
    if gs <= 0.0 or gd >= 1.0:
        return 1.0
    d = (t * gs - float(spec.get("gate_phase", 0.0))) % 1.0
    if d >= gd:
        return 0.0
    return 1.0 - float(spec.get("gate_fade", 0.0)) * (d / gd)


def _specular(
    hx: np.ndarray, hy: np.ndarray, light: np.ndarray, *, slope: float, power: float
) -> np.ndarray:
    """Normalised Blinn-Phong glint on a height-field surface: n from the
    (slope-boosted) gradient, half-vector against a top-down viewer, energy
    factor (s+8)/8π so tightening `power` doesn't dim the sparkle."""
    nz = np.full(hx.shape, 1.0, np.float32)
    nx, ny = -slope * hx, -slope * hy
    inv = 1.0 / np.sqrt(nx * nx + ny * ny + nz * nz)
    hv = _norm3(light[0], light[1], light[2] + 1.0)  # L + V, V = (0,0,1)
    ndh = np.clip((nx * hv[0] + ny * hv[1] + nz * hv[2]) * inv, 0.0, 1.0)
    return (ndh**power) * ((power + 8.0) / (8.0 * np.pi))


_WAVE_N = 10  # directional sine components per waves card
_BETA = 0.248  # refraction constant 1 − 1/n for water (n = 1.33), small-angle
_ABSORB = np.asarray([0.45, 0.12, 0.05], np.float32)  # water absorption /m (r,g,b)


def waves(nframes, h, w, fps, layers, *, frame_offset=0, base=None) -> np.ndarray:
    """Pool water: a directional sine spectrum with the deep-water dispersion
    ω = √(gk) drives three registered light paths — caustics (forward-splat of
    the refraction-map Jacobian: the filament network), refraction of `base`
    (the pool floor; palette when None) through the SAME map with per-channel
    chromatic scaling, and a surface sun glint. Merged cards superpose their
    height fields (linear wave physics) before the single render pass."""
    ih, iw = procgen.sim_dims(h, w)
    up = h / ih  # sim px -> render px
    lead = layers[0]
    stops = lead["stops"]
    clocks = [_clock(lr["speed"], fps) for lr in layers]
    draws = []  # fixed unit draws per card: log-λ, direction offsets, phases
    for lr in layers:
        rng = np.random.default_rng(int(lr.get("seed", 1)) * 613 + 17)
        draws.append(
            (
                rng.uniform(np.log(0.5), np.log(2.0), _WAVE_N),
                rng.uniform(-1.0, 1.0, _WAVE_N),
                rng.uniform(0.0, 2.0 * np.pi, _WAVE_N),
            )
        )
    g_px = 9.81 * (iw / 4.0)  # the frame spans ~4 m of pool
    sun = _norm3(0.45, -0.35, 0.82)
    out = np.empty((nframes, h, w, 4), np.uint8)
    for i in range(nframes):
        idx = frame_offset + i
        acc = None
        for lr, (lam_u, ang_u, ph_u), ck in zip(layers, draws, clocks):
            lam = (0.04 + 0.11 * float(_at(lr["scale"], idx))) * iw * np.exp(lam_u)
            steep = 0.005 + 0.075 * float(_at(lr["steepness"], idx))
            # a WIDE fan (±77°) — near-isotropic chop gives the polygonal cell
            # network of a real pool; a narrow fan degenerates into stripes
            ang = np.deg2rad(float(_at(lr["direction"], idx))) + ang_u * 1.35
            ang[-2:] += np.pi  # two components reflected off the pool walls
            k = 2.0 * np.pi / np.maximum(lam, 4.0)
            comps = np.stack(
                [steep / k, k * np.cos(ang), k * np.sin(ang), np.sqrt(g_px * k), ph_u], 1
            ).astype(np.float32)
            f6 = procgen.wave_field(ih, iw, float(ck[idx]), comps)
            acc = list(f6) if acc is None else [a + b for a, b in zip(acc, f6)]
        hgt, hx, hy, hxx, hxy, hyy = acc
        dep = float(_at(lead["depth"], idx))
        bd = _BETA * (0.25 + 2.4 * dep) * iw  # β·D in sim px (D ≈ pool depth)
        det = (1.0 - bd * hxx) * (1.0 - bd * hyy) - (bd * hxy) ** 2
        ca = procgen.caustic_map(-bd * hx, -bd * hy, det, 0.65)
        # upscale the fields once; displacement magnitudes scale with the grid
        ca_f = procgen.upscale(ca, h, w)
        hx_f = procgen.upscale(hx, h, w)
        hy_f = procgen.upscale(hy, h, w)
        dx, dy = -bd * up * hx_f, -bd * up * hy_f
        # the pool floor: upstream frame, else the palette's mid-water band
        if base is not None:
            floor = base[i][..., :3].astype(np.float32) / 255.0
        else:
            hn = hgt / (3.0 * float(hgt.std()) + 1e-6)
            floor = procgen.ramp_lookup(
                np.clip(0.45 + 0.30 * procgen.upscale(hn, h, w), 0.0, 1.0), stops
            )
        chroma = float(_at(lead["chroma"], idx)) * 0.08
        if chroma > 1e-4:  # dispersion: sample the warp at 3 per-channel scales
            refr = np.stack(
                [
                    procgen.displace(floor[..., c], dx * s, dy * s)
                    for c, s in ((0, 1.0 - chroma), (1, 1.0), (2, 1.0 + chroma))
                ],
                -1,
            )
        else:
            refr = procgen.displace(floor, dx, dy)
        tint = np.exp(-(0.2 + 2.6 * dep) * _ABSORB)  # spectral absorption ⇒ pool blue-green
        # exposure-stable caustic lighting: ca is mean-1, so dividing by the
        # mean illumination keeps the floor readable at any caustics gain
        gain = float(_at(lead["caustics"], idx)) * 1.8
        knorm = 1.0 / (0.62 + gain)
        if chroma > 1e-4:  # the caustic fringes follow the same dispersion
            cs = np.stack(
                [
                    procgen.displace(ca_f, dx * (s - 1.0), dy * (s - 1.0))
                    for s in (1.0 - chroma, 1.0, 1.0 + chroma)
                ],
                -1,
            )
            light = (0.62 + gain * cs) * knorm
            rgb = refr * tint[None, None, :] * light
        else:
            light = (0.62 + gain * ca_f) * knorm
            rgb = refr * tint[None, None, :] * light[..., None]
        shine = float(_at(lead["shine"], idx))
        if shine > 1e-4:  # surface glint — applied AFTER refraction, never warped
            # tight exponent ⇒ 1-3 px sparkles on the facets that align with the
            # sun, not washes; the energy factor keeps them bright
            spec = _specular(hx_f, hy_f, sun, slope=3.2, power=2600.0)
            rgb = rgb + (shine * 0.9) * np.minimum(spec, 3.0)[..., None]
        alpha = np.full((h, w), np.clip(float(_at(lead["opacity"], idx)), 0.0, 1.0), np.float32)
        out[i] = _rgba(np.clip(rgb, 0.0, 1.0), alpha)
    return out


def _bolt_layers(lr, e, h, w):
    """Grow + rasterise one strike's discharge for layer `lr` at edge frame `e`:
    a DBM tree (hierarchical self-avoiding branching — the real thing), scaled
    from lattice units to pixels, midpoint-jittered to the measured tortuosity,
    drawn as float intensity with conical width. Returns (L_full, L_main,
    origin_xy) — the return-stroke channel WITH branches and the bare main
    channel that restrikes (dart leaders) re-illuminate."""
    seed = int(lr.get("seed", 1))
    rng = np.random.default_rng(seed * 7919 + e * 13 + 5)
    specs = lr.get("points") or None
    if specs:
        # sample the chosen spec's position AT the strike time, so an
        # animate-points card moves the strike origins over the clip; gated-off
        # specs (chase) are skipped when any lit one remains
        total = len(np.asarray(lr["strike"]).reshape(-1))
        t01 = e / max(total - 1, 1)
        lit = [s for s in specs if _spec_gate(s, t01) > 0.0] or specs
        px, py = _spec_pos(lit[int(rng.integers(len(lit)))], t01)
    else:
        px, py = float(_at(lr["origin_x"], e)), float(_at(lr["origin_y"], e))
    origin = np.asarray([px * w, py * h], np.float32)
    span = 150
    eta = 5.3 - 3.6 * float(np.clip(_at(lr["branchiness"], e), 0.0, 1.0))
    pts, parent, tip = procgen.dbm_tree(seed * 31 + e, span=span, eta=eta)
    chains = procgen.dbm_polylines(pts, parent, tip, min_len=3)
    length_px = float(_at(lr["length"], e)) * float(np.hypot(h, w))
    s = length_px / span
    theta = np.deg2rad(float(_at(lr["direction"], e)) - 90.0)  # +y lattice -> angle
    rot = np.asarray([[np.cos(theta), -np.sin(theta)], [np.sin(theta), np.cos(theta)]], np.float32)
    thick = float(_at(lr["thickness"], e)) * max(1.0, min(h, w) / 512.0)
    ss = 2  # supersample the rasterisation, then box-downsample
    full = Image.new("F", (w * ss, h * ss), 0.0)
    main_img = Image.new("F", (w * ss, h * ss), 0.0)
    dfull = ImageDraw.Draw(full)
    dmain = ImageDraw.Draw(main_img)
    for pl, depth in chains:
        world = (pl * s) @ rot.T + origin  # lattice (x, growth-axis) -> screen
        world = procgen.jitter_polyline(world, rng, rounds=2, sigma=0.29)
        inten = 0.38**depth
        wd = max(1, int(round(thick * (0.55**depth) * ss)))
        third = max(2, len(world) // 3)
        segs = [
            (world[: third + 1], 1.0),
            (world[third : 2 * third + 1], 0.8),
            (world[2 * third :], 0.55),
        ]  # taper toward the tip
        for part, taper in segs:
            if len(part) < 2:
                continue
            xy = [(float(p[0]) * ss, float(p[1]) * ss) for p in part]
            dfull.line(xy, fill=inten * taper, width=wd, joint="curve")
            if depth == 0:
                dmain.line(xy, fill=inten * taper, width=wd, joint="curve")
    l_full = np.asarray(full.resize((w, h), Image.BILINEAR), np.float32)
    l_main = np.asarray(main_img.resize((w, h), Image.BILINEAR), np.float32)
    return l_full, l_main, origin


def _glow_stack(layer: np.ndarray, scale: float) -> np.ndarray:
    """Multi-scale Gaussian stack ≈ the atmospheric point-spread function: the
    heavy-tailed halo real bolts wear (σ 6/24/64 px @512, weights ÷2/octave)."""
    outv = layer.copy()
    for sig, wt in ((6.0, 0.5), (24.0, 0.25), (64.0, 0.12)):
        outv = outv + wt * gaussian_filter(layer, sig * scale)
    return outv


def _strike_events(lr, total: int, fps: float) -> list[int]:
    st = np.asarray(lr["strike"], np.float32).reshape(-1)[:total]
    return [e for e in range(len(st)) if st[e] >= 0.5 and (e == 0 or st[e - 1] < 0.5)]


def lightning(
    nframes, h, w, fps, layers, *, frame_offset=0, bolt_cache: dict | None = None
) -> np.ndarray:
    """Sky-tearing discharges. Geometry: dielectric-breakdown growth per strike
    (cached — reused across the flash, which is physically right). Temporal
    model = the three perceptive signatures of real lightning: an instantaneous
    full-channel return stroke, 2-5 restrikes of the SAME channel minus its
    branches at ~45-60 ms (dart leaders — the characteristic flicker), and a
    continuing-current afterglow pedestal. Rendering: additive linear HDR + a
    saturating tonemap, so the core clips to white while the halo keeps the
    palette tint. `bolt_cache` lets the block streamer reuse strike geometry
    across blocks (keyed (layer_index, strike_frame))."""
    cache = bolt_cache if bolt_cache is not None else {}
    total = max(len(np.asarray(lr["strike"]).reshape(-1)) for lr in layers)
    blur_scale = max(1e-3, min(h, w) / 512.0)
    events = []  # (layer, edge frame, restrike times/peaks, per-event scalars)
    for li, lr in enumerate(layers):
        for e in _strike_events(lr, total, fps):
            rng = np.random.default_rng(int(lr.get("seed", 1)) * 101 + e)
            flick = float(np.clip(_at(lr["flicker"], e), 0.0, 1.0))
            n_re = int(round(1 + 4 * flick * float(rng.random()) ** 0.5))
            t_k = [0.0]
            for _ in range(n_re):
                t_k.append(t_k[-1] + 0.038 + 0.035 * float(rng.random()))
            peaks = [1.0] + [0.5 + 0.4 * float(rng.random()) for _ in range(n_re)]
            after = float(np.clip(_at(lr["afterglow"], e), 0.0, 1.0))
            events.append(
                {
                    "li": li,
                    "lr": lr,
                    "e": e,
                    "t_k": t_k,
                    "peaks": peaks,
                    "tau_cc": 0.08 + 0.45 * after,
                    "ped": 0.05 + 0.22 * after,
                    "flash": float(_at(lr["flash"], e)),
                    "glow": float(np.clip(_at(lr["glow"], e), 0.0, 1.0)),
                }
            )
    lead = layers[0]
    stops = lead["stops"]
    glow_col = np.asarray(procgen.ramp_lookup(np.float32(0.25), stops), np.float32)
    core_col = np.asarray(procgen.ramp_lookup(np.float32(0.9), stops), np.float32)
    tau_s = 0.012  # per-stroke luminosity decay (s) — sub-frame at video rates
    yy = np.arange(h, dtype=np.float32)[:, None]
    xx = np.arange(w, dtype=np.float32)[None, :]
    out = np.empty((nframes, h, w, 4), np.uint8)
    for i in range(nframes):
        idx = frame_offset + i
        t_now = idx / max(fps, 1e-6)
        lin = np.zeros((h, w, 3), np.float32)
        for ev in events:
            age = t_now - ev["e"] / max(fps, 1e-6)
            life = ev["t_k"][-1] + 0.06 + 4.5 * ev["tau_cc"]
            if age < 0 or age > life:
                continue
            key = (ev["li"], ev["e"])
            if key not in cache:
                cache[key] = _bolt_layers(ev["lr"], ev["e"], h, w) + (
                    None,
                    None,
                )  # glow stacks fill lazily below
            l_full, l_main, origin, g_full, g_main = cache[key]
            if g_full is None:
                g_full = _glow_stack(l_full, blur_scale)
                g_main = _glow_stack(l_main, blur_scale)
                cache[key] = (l_full, l_main, origin, g_full, g_main)
            # stroke envelopes, sampled at frame time (τ ≈ 12 ms — one bright
            # frame per stroke; aliasing against the frame grid is the look)
            e0 = (
                ev["peaks"][0] * float(np.exp(-max(age - ev["t_k"][0], 0.0) / tau_s))
                if age >= ev["t_k"][0]
                else 0.0
            )
            ek = 0.0
            for tk, pk in zip(ev["t_k"][1:], ev["peaks"][1:]):
                if age >= tk:
                    ek += pk * float(np.exp(-(age - tk) / tau_s))
            ped = ev["ped"] * float(np.exp(-age / ev["tau_cc"]))
            gg = 0.4 + 2.2 * ev["glow"]
            hdr_full = e0 + ped
            if hdr_full > 1e-4:
                lin += ((hdr_full * 14.0) * l_full)[..., None] * core_col
                lin += ((hdr_full * gg) * (g_full - l_full))[..., None] * glow_col
            if ek > 1e-4:
                lin += ((ek * 14.0) * l_main)[..., None] * core_col
                lin += ((ek * gg) * (g_main - l_main))[..., None] * glow_col
            if ev["flash"] > 1e-4:  # sky pulse ∝ instantaneous power, hugging
                power = e0 + ek + ped  # the origin (cloud-scatter, not a veil)
                r2 = ((xx - origin[0]) ** 2 + (yy - origin[1]) ** 2) / (0.18 * (h * h + w * w))
                lin += (ev["flash"] * power * 0.32 / (1.0 + 6.0 * r2))[..., None] * glow_col
        tone = 1.0 - np.exp(-lin)
        tone = np.clip(tone, 0.0, 1.0) ** (1.0 / 2.2)
        opac = np.clip(float(_at(lead["opacity"], idx)), 0.0, 1.0)
        alpha = np.clip(tone.max(axis=2) * 1.25, 0.0, 1.0) * opac
        out[i] = _rgba(tone, alpha)
    return out


def _noise_row(seed: int, k: int) -> np.ndarray:
    """K random lattice values in 0..1 for one striation row (deterministic)."""
    return np.random.default_rng(seed).random(max(2, k)).astype(np.float32)


def _row_at(vals: np.ndarray, xq: np.ndarray) -> np.ndarray:
    """Sample a wrapped 1-D value-noise lattice at continuous positions `xq`
    (cycles across the row), smoothstep-interpolated — the aurora's vertical
    ray striations, evaluable at sheared coordinates."""
    k = len(vals)
    p = (xq % 1.0) * k
    i0 = np.floor(p).astype(np.int64) % k
    f = procgen.smoothstep(p - np.floor(p))
    return vals[i0] * (1.0 - f) + vals[(i0 + 1) % k] * f


def aurora(nframes, h, w, fps, layers, *, frame_offset=0) -> np.ndarray:
    """Northern-light curtains, built like the physically-based renderers
    factorise them: emission = arc footprint × vertical deposition. Each band is
    a near-HORIZONTAL arc y_c(x) (three fold scales), a Chapman-layer profile
    hangs rays above it (sharp bottom edge — the real ~100 km cutoff — long
    soft top), striation INTENSITIES crossfade on the ~1 s oxygen-line
    timescale (positions never slide), and colour stratifies by altitude
    through the palette (purple fringe → green → red top). Merged cards add
    their curtains into the same linear sky before one shared tonemap."""
    ih, iw = procgen.sim_dims(h, w, cap=384)
    out = np.empty((nframes, h, w, 4), np.uint8)
    xxn = np.linspace(0.0, 1.0, iw, dtype=np.float32)[None, :]
    yyn = np.linspace(0.0, 1.0, ih, dtype=np.float32)[:, None]
    clocks = [_clock(lr["drift"], fps) for lr in layers]
    lead = layers[0]
    for i in range(nframes):
        idx = frame_offset + i
        t = idx / max(fps, 1e-6)
        sky = np.zeros((ih, iw, 3), np.float32)
        for lr, ck in zip(layers, clocks):
            seed = int(lr.get("seed", 1))
            stops = lr["stops"]
            nb = max(1, int(round(float(_at(lr["bands"], idx)))))
            pos = float(_at(lr["position_y"], idx))
            h_up = 0.06 + 0.30 * float(_at(lr["height"], idx))
            h_low = 0.015
            sway_a = float(_at(lr["sway"], idx))
            drift = float(ck[idx]) * 0.15  # quiet-arc drift: ~0.15 width/s max
            shimmer = float(np.clip(_at(lr["shimmer"], idx), 0.0, 1.0))
            period = 1.6 - 1.25 * shimmer  # ray lifetime 0.35-1.6 s
            k_rays = int(40 + 80 * float(np.clip(_at(lr["rays"], idx), 0.0, 1.0)))
            bright = float(_at(lr["brightness"], idx)) * 1.9 / max(nb, 1)
            for b in range(nb):
                rngb = np.random.default_rng(seed * 47 + b * 7)
                y0 = pos + (b - (nb - 1) / 2.0) * (0.16 + 0.10 * h_up)
                # the arc: three fold scales, slow phase drift along the curtain
                yc = y0
                for fj, aj, sj in ((0.7, 0.10, 1.0), (1.8, 0.045, -0.6), (4.0, 0.015, 0.35)):
                    ph = float(rngb.uniform(0, 2 * np.pi))
                    yc = yc + (aj * (0.3 + 1.4 * sway_a)) * np.sin(
                        2 * np.pi * (fj * (xxn + drift * sj)) + ph + 0.35 * sj * t * (0.2 + sway_a)
                    )
                z = yc - yyn  # altitude above the arc's bottom edge (screen-up)
                u = np.where(z >= 0, z / h_up, z / h_low)
                prof = np.exp(1.0 - u - np.exp(-u))  # Chapman layer, asymmetric
                # rays: high-frequency striations along x, sheared toward the
                # zenith, whose INTENSITIES crossfade — never slide sideways
                xs = xxn + 0.35 * z * (xxn - 0.5)
                cell = int(np.floor(t / period))
                fr = procgen.smoothstep(np.float32(t / period - cell))
                r0 = _row_at(_noise_row(seed * 977 + b * 31 + cell, k_rays), xs)
                r1 = _row_at(_noise_row(seed * 977 + b * 31 + cell + 1, k_rays), xs)
                stri = (1.0 - fr) * r0 + fr * r1
                stri = 0.30 + 0.70 * stri**2.5  # sharpen; floor keeps the veil
                alt = np.clip((z + 0.4 * h_low) / (2.0 * h_up), 0.0, 1.0)
                emission = (prof * stri * bright).astype(np.float32)
                sky += emission[..., None] * procgen.ramp_lookup(alt, stops)
        # magnitude-preserving gamma on the linear sky (hue survives the lift)
        sky_g = sky * np.maximum(sky.max(axis=2, keepdims=True), 1e-6) ** (1.0 / 2.2 - 1.0)
        rgb = procgen.upscale(np.clip(sky_g, 0.0, 1.0), h, w)
        lum = procgen.upscale(np.clip(sky.max(axis=2) * 1.8, 0.0, 1.0), h, w)
        alpha = lum * np.clip(float(_at(lead["opacity"], idx)), 0.0, 1.0)
        out[i] = _rgba(rgb, alpha)
    return out


def _rain_drops(lr, idx: int, ph: int, pw: int, pad: int, fps: float):
    """The drops landing at absolute frame `idx` for one layer: a deterministic
    Poisson schedule from (seed, idx) — never global RNG state — so streamed
    blocks and re-renders see the identical storm. Returns [(y, x, amp, sigma)]
    in padded-grid units. With a wired points card, drops fall on those specs'
    positions (+ a little jitter) — sampled at THIS frame's time, so an
    animate-points card makes the drip points travel, and its chase gate
    silences drips as the lit window sweeps past them."""
    rng = np.random.default_rng(int(lr.get("seed", 1)) * 9176 + idx)
    dens = float(np.clip(_at(lr["density"], idx), 0.0, 1.0))
    lam = dens * 22.0 / max(fps, 1e-6)  # up to ~22 drops/s
    n = int(rng.poisson(lam))
    if n <= 0:
        return []
    size = float(np.clip(_at(lr["drop_size"], idx), 0.0, 1.0))
    specs = lr.get("points") or None
    total = len(np.asarray(lr["density"]).reshape(-1))
    t01 = idx / max(total - 1, 1)
    out = []
    for _ in range(n):
        if specs:
            spec = specs[int(rng.integers(len(specs)))]
            if float(rng.random()) >= _spec_gate(spec, t01):
                continue  # this drip is gated off right now (chase sweep)
            x0, y0 = _spec_pos(spec, t01)
            x = pad + x0 * (pw - 2 * pad) + float(rng.normal(0, 1.5))
            y = pad + y0 * (ph - 2 * pad) + float(rng.normal(0, 1.5))
        else:
            x = pad + float(rng.random()) * (pw - 2 * pad)
            y = pad + float(rng.random()) * (ph - 2 * pad)
        sigma = (2.5 + 5.5 * size) * (0.8 + 0.4 * float(rng.random()))
        amp = (0.55 + 0.9 * size) * (0.7 + 0.6 * float(rng.random()))
        out.append((y, x, amp, sigma))
    return out


def _stamp(u: np.ndarray, y: float, x: float, amp: float, ker: np.ndarray):
    """Add a drop stamp into the (padded) height field, clipped at the borders."""
    r = ker.shape[0] // 2
    iy, ix = int(round(y)), int(round(x))
    y0, y1 = max(0, iy - r), min(u.shape[0], iy + r + 1)
    x0, x1 = max(0, ix - r), min(u.shape[1], ix + r + 1)
    if y1 <= y0 or x1 <= x0:
        return
    u[y0:y1, x0:x1] += amp * ker[y0 - iy + r : y1 - iy + r, x0 - ix + r : x1 - ix + r]


def rain(nframes, h, w, fps, layers, *, frame_offset=0, base=None, state=None):
    """Raindrops on a liquid surface whose floor is `base` (palette when None).
    The surface is the exact linear wave physics: a spectral propagator with
    the capillary dispersion ω² = gk + sk³ (fine ripples genuinely outrun the
    main ring) and per-k viscous damping, on a ~25%-padded grid so the periodic
    wrap never shows. Each drop is the 3-beat Worthington sequence — crater,
    central rebound jet, secondary impact — as zero-volume Mexican-hat stamps;
    rings from every drop (and every merged card) propagate, collide and
    interfere in the ONE shared field. Stateful: returns (frames, state) and
    the block streamer threads `state` through contiguous produce() calls."""
    ih, iw = procgen.sim_dims(h, w, cap=448)
    pad = max(8, ih // 8)
    ph_g, pw_g = ih + 2 * pad, iw + 2 * pad
    lead = layers[0]
    stops = lead["stops"]
    ker_key, c1, c2 = None, None, None
    if state is None:
        z = np.zeros((ph_g, pw_g), np.complex64)
        state = {"hhat": z, "hprev": z.copy()}
    hhat, hprev = state["hhat"], state["hprev"]
    kers: dict[float, np.ndarray] = {}
    sun = _norm3(0.4, -0.55, 0.73)
    up = h / ih
    out = np.empty((nframes, h, w, 4), np.uint8)
    for i in range(nframes):
        idx = frame_offset + i
        # (re)build the propagator when the surface ports change — keyed to the
        # ABSOLUTE frame's values, so blocks and the whole clip rebuild at the
        # exact same frames and the state evolution stays bit-identical
        spd = round(float(np.clip(_at(lead["ripple_speed"], idx), 0.05, 4.0)), 3)
        dec = round(2.0 + 55.0 * (1.0 - float(np.clip(_at(lead["decay"], idx), 0.0, 1.0))), 2)
        if (spd, dec) != ker_key:
            ker_key = (spd, dec)
            c1, c2 = procgen.ripple_kernel(ph_g, pw_g, fps, 0.25 + 1.5 * spd, dec)
        # inject every stamp due THIS frame: drops schedule 3 beats (0 / +0.1 s
        # jet / +0.4 s faint secondary), all keyed to their launch frame
        beats = (
            (0, -1.0, 1.0),
            (int(round(0.1 * fps)), 0.55, 0.5),
            (int(round(0.4 * fps)), -0.35, 0.85),
        )
        impact = None
        for lr in layers:
            for db, bamp, bsig in beats:
                for y, x, amp, sig in _rain_drops(lr, idx - db, ph_g, pw_g, pad, fps):
                    s = round(max(1.5, sig * bsig), 1)
                    if s not in kers:
                        kers[s] = procgen.mexican_hat(s)
                    if impact is None:
                        impact = np.zeros((ph_g, pw_g), np.float32)
                    _stamp(impact, y, x, amp * bamp, kers[s])
        if impact is not None:
            hhat = hhat + procgen.ripple_fft(impact)
        hhat, hprev = procgen.ripple_step(hhat, hprev, c1, c2)
        u = procgen.ripple_ifft(hhat)[pad : pad + ih, pad : pad + iw]
        u_f = procgen.upscale(u, h, w)
        uy, ux = np.gradient(u_f)
        dist = float(_at(lead["distort"], idx)) * 26.0 / up
        if base is not None:
            floor = base[i][..., :3].astype(np.float32) / 255.0
            rgb = procgen.displace(floor, dist * ux, dist * uy)
        else:
            diff = np.clip(0.55 - 2.2 * (ux * sun[0] + uy * sun[1]), 0.0, 1.0)
            rgb = procgen.ramp_lookup(diff, stops)
        shine = float(_at(lead["shine"], idx))
        if shine > 1e-4:
            spec = _specular(ux, uy, sun, slope=14.0, power=180.0)
            rgb = rgb + (shine * 2.0) * spec[..., None]
        alpha = np.full((h, w), np.clip(float(_at(lead["opacity"], idx)), 0.0, 1.0), np.float32)
        out[i] = _rgba(np.clip(rgb, 0.0, 1.0), alpha)
    state = {"hhat": hhat, "hprev": hprev}
    return out, state


def _cloud_density(lr, idx: int, t_drift: float, ih: int, iw: int) -> np.ndarray:
    """One card's cloud density field: billow-shaped fbm, domain-warped (the
    cauliflower edges), eroded by a faster high-frequency detail pass via
    `remap` (never a multiply — it hollows the core), then an exponential
    coverage shoulder: saturated interiors, feathered edges. Stateless — a
    pure function of (t, params), so it seeks and block-streams for free."""
    seed = int(lr.get("seed", 1))
    sc = float(np.clip(_at(lr["scale"], idx), 0.0, 1.0))
    cells = max(2, int(round(5.5 - 3.5 * sc)))
    ang = np.deg2rad(float(_at(lr["direction"], idx)))
    ox, oy = t_drift * np.cos(ang) * 0.06, t_drift * np.sin(ang) * 0.06
    macro = procgen.fbm2d(ih, iw, cells=cells, octaves=5, seed=seed, scroll_x=ox, scroll_y=oy)
    turb = float(np.clip(_at(lr["turbulence"], idx), 0.0, 1.0))
    if turb > 1e-3:  # warp offsets evolve with time — morphing, not sliding
        wx = (
            procgen.fbm2d(
                ih,
                iw,
                cells=3,
                octaves=3,
                seed=seed + 11,
                scroll_x=ox * 0.5 + t_drift * 0.008,
                scroll_y=oy * 0.5,
            )
            - 0.5
        )
        wy = (
            procgen.fbm2d(
                ih,
                iw,
                cells=3,
                octaves=3,
                seed=seed + 23,
                scroll_x=ox * 0.5,
                scroll_y=oy * 0.5 + t_drift * 0.008,
            )
            - 0.5
        )
        amp = (0.10 + 0.35 * turb) * iw / max(cells, 1)
        macro = procgen.displace(macro, wx * amp, wy * amp)
    # smooth fbm blobs give compact cumulus MASSES against open sky (the folded
    # "billow" transform makes a connected sponge — sky reads as holes); the
    # billowed detail pass rides the rims as cauliflower, faster drift (2.5×)
    detail = procgen.fbm2d(
        ih, iw, cells=cells * 3, octaves=3, seed=seed + 5, scroll_x=ox * 2.5, scroll_y=oy * 2.5
    )
    bloom = 1.0 - np.abs(2.0 * detail - 1.0)
    shape = macro + (0.10 + 0.16 * turb) * (bloom - 0.5)
    cov = float(np.clip(_at(lr["coverage"], idx), 0.0, 1.0))
    soft = float(np.clip(_at(lr["softness"], idx), 0.0, 1.0))
    thr = 0.92 - 0.60 * cov  # cov 0.5 ⇒ ~1/3 sky filled — sky stays the ground
    kk = 4.0 + 11.0 * (1.0 - soft)
    dens = 1.0 - np.exp(-kk * np.maximum(shape - thr, 0.0))
    yy = np.linspace(0.0, 1.0, ih, dtype=np.float32)[:, None]
    band = np.clip(1.15 - 0.5 * yy, 0.55, 1.0)  # trapezoid: wispier low bases
    return (dens * band).astype(np.float32)


def clouds(nframes, h, w, fps, layers, *, frame_offset=0) -> np.ndarray:
    """Sunlit clouds — the Nubis/Horizon recipe folded into 2-D. Density per
    card (billow + warp + erosion + coverage shoulder); merged cards' densities
    combine BEFORE the one lighting pass, so their masses genuinely shade each
    other under one sun. Lighting: a short Beer-Lambert march toward the sun
    (real self-shadowing), the Beer-powder term (crevices read brighter than
    bulges — the dark-rim/bright-inside profile of real cumulus), a blurred-
    density in-scatter proxy, and a screen-space Henyey-Greenstein silver
    lining that blazes on thin rims around the sun's position."""
    ih, iw = procgen.sim_dims(h, w, cap=448)
    out = np.empty((nframes, h, w, 4), np.uint8)
    clocks = [_clock(lr["drift"], fps) for lr in layers]
    lead = layers[0]
    stops = lead["stops"]
    yy = np.linspace(0.0, 1.0, ih, dtype=np.float32)[:, None]
    xx = np.linspace(0.0, 1.0, iw, dtype=np.float32)[None, :]
    for i in range(nframes):
        idx = frame_offset + i
        dens = None
        for lr, ck in zip(layers, clocks):
            d = _cloud_density(lr, idx, float(ck[idx]), ih, iw)
            dens = d if dens is None else np.clip(dens + d, 0.0, 1.0)
        ang = np.deg2rad(float(_at(lead["light_angle"], idx)))
        sdx, sdy = np.cos(ang), np.sin(ang)
        shading = float(np.clip(_at(lead["shading"], idx), 0.0, 1.0))
        # short sun-march: optical depth = summed density toward the sun
        steps, step_px = 6, max(1.5, 0.006 * iw)
        tau = np.zeros((ih, iw), np.float32)
        rngj = np.random.default_rng(1234 + idx)  # ±0.5 px jitter kills banding
        for k in range(1, steps + 1):
            jit = float(rngj.uniform(-0.5, 0.5))
            tau += procgen.displace(dens, -(k + jit) * step_px * sdx, -(k + jit) * step_px * sdy)
        tau *= 0.42 * shading + 0.04  # core τ ≈ 2.5-3 at full shading
        beer = np.exp(-tau)
        powder = 2.0 * beer * (1.0 - np.exp(-2.0 * tau))
        # multiple scattering keeps real cumulus cores grey-white, never black:
        # the blurred-density in-scatter proxy is the lighting FLOOR, direct
        # sun + powder ride on top of it
        insc = gaussian_filter(dens, 0.02 * iw)
        lit = (0.40 + 0.22 * insc) + 0.42 * beer + 0.30 * powder * shading
        silver = float(np.clip(_at(lead["silver"], idx), 0.0, 1.0))
        if silver > 1e-3:  # HG(g≈0.95) around a fake sun position behind the field
            sun_x, sun_y = 0.5 - 0.48 * sdx, 0.5 - 0.48 * sdy
            r = np.hypot(xx - sun_x, yy - sun_y)
            cosq = np.clip(1.0 - r * 1.4, -1.0, 1.0)
            g = 0.94
            hg = (1 - g * g) / (4 * np.pi * (1 + g * g - 2 * g * cosq) ** 1.5)
            lit = lit + silver * 0.9 * (hg / hg.max()) * beer * (1.0 - dens)
        bright = float(_at(lead["brightness"], idx))
        rgb_s = procgen.ramp_lookup(np.clip(lit, 0.0, 1.0), stops) * (0.35 + 0.95 * bright)
        alpha_s = procgen.smoothstep(np.clip(dens * 1.6, 0.0, 1.0))
        rgb = procgen.upscale(np.clip(rgb_s, 0.0, 1.0), h, w)
        alpha = procgen.upscale(alpha_s, h, w) * np.clip(float(_at(lead["opacity"], idx)), 0.0, 1.0)
        out[i] = _rgba(rgb, np.clip(alpha, 0.0, 1.0))
    return out


def image(
    nframes,
    h,
    w,
    *,
    asset_path,
    box_x=0.0,
    box_y=0.0,
    box_w=1.0,
    box_h=1.0,
    fit="cover",
    opacity,
    frame_offset=0,
) -> np.ndarray:
    """A still image as an RGBA layer `(nframes, h, w, 4)`. Placed into the box (fractions
    0..1, default full-frame) per `fit`; alpha = the image's own alpha × box coverage,
    scaled per frame by `opacity`. `frame_offset` is unused (static) — kept so the block
    renderer can call it the same way as `video`/`lyrics`."""
    base = np.zeros((h, w, 4), np.uint8)
    if asset_path:
        try:
            src = np.asarray(Image.open(asset_path).convert("RGBA"), np.uint8)
            x0, y0, bw, bh = _place_box(w, h, box_x, box_y, box_w, box_h)
            base[y0 : y0 + bh, x0 : x0 + bw] = _fit_rgba(src, bw, bh, fit)
        except (OSError, ValueError, Image.DecompressionBombError):
            pass  # missing/corrupt/oversized asset -> empty (transparent) layer
    return _apply_opacity(base, nframes, opacity)


@lru_cache(maxsize=128)
def _video_meta(path: str):
    """(duration_sec, width, height) for a video, via ffprobe (cached)."""
    out = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height:format=duration",
            "-of",
            "json",
            path,
        ],
        capture_output=True,
        text=True,
    )
    try:
        j = json.loads(out.stdout or "{}")
    except ValueError:
        return 0.0, 16, 16
    st = (j.get("streams") or [{}])[0]
    return (
        float(j.get("format", {}).get("duration") or 0.0),
        int(st.get("width") or 16),
        int(st.get("height") or 16),
    )


def _fit_vf(bw: int, bh: int, fit: str) -> str:
    """ffmpeg -vf fit chain producing exactly bw x bh RGBA (transparent letterbox for
    `contain`)."""
    if fit == "stretch":
        return f"scale={bw}:{bh}"
    if fit == "contain":
        return (
            f"scale={bw}:{bh}:force_original_aspect_ratio=decrease,"
            f"pad={bw}:{bh}:(ow-iw)/2:(oh-ih)/2:color=#00000000"
        )
    return f"scale={bw}:{bh}:force_original_aspect_ratio=increase,crop={bw}:{bh}"  # cover


class VideoClip:
    """A resumable decoder for one video-layer node — the `fluid.FluidClip` of video.

    Block streaming used to spawn a fresh ffmpeg per ~5s block, each paying seek +
    pipeline-init and re-decoding overlapping GOP data. Because the block renderer's
    source times are non-decreasing (speed >= 0, blocks are front-to-back), ONE
    persistent rawvideo decoder can instead be opened at the first request and simply
    read FORWARD across `frames()` calls. A backward request (never in normal
    streaming; safety) transparently reopens the decoder at the new time, so
    correctness never depends on decoder state.
    """

    def __init__(
        self,
        h,
        w,
        fps,
        *,
        asset_path,
        box_x=0.0,
        box_y=0.0,
        box_w=1.0,
        box_h=1.0,
        fit="cover",
        loop=True,
        crop_x=0.0,
        crop_y=0.0,
        crop_w=1.0,
        crop_h=1.0,
    ):
        self.h, self.w, self.fps = int(h), int(w), int(fps)
        self.x0, self.y0, self.bw, self.bh = _place_box(self.w, self.h, box_x, box_y, box_w, box_h)
        self.path = str(asset_path) if asset_path else ""
        self.fit = fit
        # Source crop (fractions of the SOURCE frame, before fit): the selected region is
        # what gets fitted into the box, so a clip too wide/tall for the format can show
        # exactly the part the user picked. Clamped in-frame and non-degenerate; the
        # identity crop adds NO filter, keeping existing renders byte-identical.
        cx = min(max(float(crop_x), 0.0), 0.99)
        cy = min(max(float(crop_y), 0.0), 0.99)
        cw = min(max(float(crop_w), 0.01), 1.0 - cx)
        ch = min(max(float(crop_h), 0.01), 1.0 - cy)
        self._crop_vf = (
            ""
            if (cx, cy, cw, ch) == (0.0, 0.0, 1.0, 1.0)
            # max(1, …) guards a sub-pixel crop on a tiny source (ffmpeg needs >= 1px).
            else f"crop=max(1\\,iw*{cw:.4f}):max(1\\,ih*{ch:.4f}):iw*{cx:.4f}:ih*{cy:.4f},"
        )
        self.loop = bool(loop)
        self.dur = _video_meta(self.path)[0] if self.path else 0.0
        self._proc: "subprocess.Popen | None" = None
        self._seek = 0.0  # source time of decoded stream frame 0
        self._fold = 0.0  # whole loops subtracted from request times (loop mode)
        self._read = 0  # frames consumed from the stream so far
        self._last: "np.ndarray | None" = None  # most recently decoded frame
        self._eof = False

    def close(self) -> None:
        if self._proc is None:
            return
        try:
            self._proc.stdout.close()
        except OSError:
            pass
        self._proc.kill()
        self._proc.wait()
        self._proc = None

    def _open(self, t0: float) -> None:
        """(Re)start the decoder so stream frame 0 is the source frame at time `t0`.
        With `loop`, whole loops are folded out of the seek (`-stream_loop -1` covers
        overruns past the clip end); the `fps` filter resamples the source onto the
        output grid so index math stays uniform. NO `-t`/`-frames:v` cap — frames are
        pulled lazily, the pipe back-pressures ffmpeg, and `close()` reaps it."""
        self.close()
        self._fold = (
            float(np.floor(t0 / self.dur) * self.dur) if (self.loop and self.dur > 0) else 0.0
        )
        self._seek = t0 - self._fold
        cmd = ["ffmpeg", "-v", "error"]
        if self.loop:
            cmd += ["-stream_loop", "-1"]
        cmd += [
            "-ss",
            f"{max(0.0, self._seek):.4f}",
            "-i",
            self.path,
            "-vf",
            f"fps={self.fps},format=rgba," f"{self._crop_vf}{_fit_vf(self.bw, self.bh, self.fit)}",
            "-pix_fmt",
            "rgba",
            "-f",
            "rawvideo",
            "-",
        ]
        self._proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self._read = 0
        self._last = None
        self._eof = False

    def _frame(self, idx: int):
        """Read forward to stream frame `idx` and return it; at/after EOF (short or
        non-looping clip) the last decoded frame holds. None until a frame decodes."""
        n = self.bw * self.bh * 4
        while self._read <= idx and not self._eof:
            buf = self._proc.stdout.read(n)
            if not buf or len(buf) < n:
                self._eof = True
                break
            self._last = np.frombuffer(buf, np.uint8).reshape(self.bh, self.bw, 4)
            self._read += 1
        return self._last

    def frames(self, src_t) -> np.ndarray:
        """RGBA frames `(len(src_t), h, w, 4)` sampling the source at times `src_t`
        (seconds, non-decreasing within AND across calls), placed into the box. Alpha
        is the box/letterbox coverage; the caller scales it by `opacity`."""
        count = len(src_t)
        out = np.zeros((count, self.h, self.w, 4), np.uint8)
        if not self.path or count == 0:
            return out
        src_t = np.asarray(src_t, np.float64)
        if self.dur > 0 and not self.loop:  # hold the last frame once past the end
            src_t = np.clip(src_t, 0.0, max(0.0, self.dur - 1.0 / float(self.fps)))
        if self._proc is None:
            self._open(float(src_t[0]))
        idx = np.round((src_t - self._fold - self._seek) * self.fps).astype(int)
        if idx[0] < max(0, self._read - 1):  # backward jump -> reopen at the new time
            self._open(float(src_t[0]))
            idx = np.round((src_t - self._fold - self._seek) * self.fps).astype(int)
        idx = np.maximum(idx, 0)
        for i, k in enumerate(idx):
            f = self._frame(int(k))
            if f is not None:
                out[i, self.y0 : self.y0 + self.bh, self.x0 : self.x0 + self.bw] = f
        return out


class SlideshowClip:
    """A slideshow of MIXED image/video items as an RGBA layer, driven by a whole-
    segment per-frame `index` (item shown at each frame; computed once from the trigger).

    Built once, streamed per block — the same "build once, read forward" shape as
    `VideoClip` — so the whole-clip and block handlers share ONE core and stay
    byte-identical (the render lockstep invariant). Image items are pre-fitted into the
    box ONCE (like `imagegen`); each video item owns its own resumable `VideoClip`
    (loop=True). A video item plays from its in-point (`start`) for as long as the
    trigger keeps it visible; each fresh RUN (a return to that item after the sequence
    moved on) restarts at the in-point — a backward jump `VideoClip.frames` absorbs by
    reopening its decoder.

    The playhead of a video item at a given frame is `start + age/fps`, where `age` is
    the number of frames since the CURRENT contiguous run of that item began. `age` and
    `run_id` are precomputed over the WHOLE segment (never per block), so a run that
    straddles a block seam keeps counting forward and streamed output equals the
    whole-clip render frame-for-frame.
    """

    def __init__(
        self, h, w, fps, *, items, index, box_x=0.0, box_y=0.0, box_w=1.0, box_h=1.0, fit="cover"
    ):
        self.h, self.w, self.fps = int(h), int(w), int(fps)
        self.x0, self.y0, self.bw, self.bh = _place_box(self.w, self.h, box_x, box_y, box_w, box_h)
        self.index = np.asarray(index, np.int64)
        self.n_items = len(items)
        # Run-relative timing over the whole segment (see class docstring).
        n = len(self.index)
        new_run = np.ones(n, bool)
        if n > 1:
            new_run[1:] = self.index[1:] != self.index[:-1]
        pos = np.arange(n)
        run_start = np.maximum.accumulate(np.where(new_run, pos, 0)) if n else pos
        self.age = pos - run_start  # frames since the current slide appeared
        self.run_id = np.cumsum(new_run) - 1 if n else pos  # unique id per contiguous run
        # Build each item: image -> fitted tile (video slot None); video -> its own
        # VideoClip (tile slot None). Slots stay index-aligned with `items`.
        self.tiles: list = []
        self.clips: list = []
        self.starts: list = []
        for it in items:
            path, kind = it.get("path", ""), it.get("kind", "image")
            if kind == "video" and path:
                clip = VideoClip(
                    self.h,
                    self.w,
                    self.fps,
                    asset_path=path,
                    box_x=box_x,
                    box_y=box_y,
                    box_w=box_w,
                    box_h=box_h,
                    fit=fit,
                    loop=True,
                )
                self.tiles.append(None)
                self.clips.append(clip)
                self.starts.append(float(it.get("start", 0.0) or 0.0))
            else:
                tile = np.zeros((self.bh, self.bw, 4), np.uint8)  # transparent fallback
                if path:
                    try:
                        src = np.asarray(Image.open(path).convert("RGBA"), np.uint8)
                        tile = _fit_rgba(src, self.bw, self.bh, fit)
                    except (OSError, ValueError, Image.DecompressionBombError):
                        pass
                self.tiles.append(tile)
                self.clips.append(None)
                self.starts.append(0.0)

    def frames(self, a, b, opacity) -> np.ndarray:
        """RGBA frames `[a, b)` as `(b-a, h, w, 4)`, alpha scaled by the block-sliced
        `opacity` (len b-a). Exactly one item is active per frame (the `index`), so each
        item paints its frames independently and they never overlap."""
        a, b = int(a), int(b)
        count = b - a
        out = np.zeros((max(count, 0), self.h, self.w, 4), np.uint8)
        if count <= 0 or not self.n_items:
            return out
        idx_block = self.index[a:b] % self.n_items
        for item in np.unique(idx_block):
            local = np.nonzero(idx_block == item)[0]  # positions within this block
            clip = self.clips[int(item)]
            if clip is None:  # image item: paste its tile on every active frame
                out[local, self.y0 : self.y0 + self.bh, self.x0 : self.x0 + self.bw] = self.tiles[
                    int(item)
                ]
                continue
            # Video item: split the active frames into contiguous RUNS (a single block can
            # hold two separate runs of the same item, e.g. index v,w,v). VideoClip.frames
            # only checks for a backward jump at its FIRST element, so a mid-array reset
            # would corrupt — call it once per run, in forward order.
            glob = local + a
            splits = np.where(np.diff(self.run_id[glob]) != 0)[0] + 1
            for grp in np.split(np.arange(len(local)), splits):
                lpos = local[grp]
                src_t = self.starts[int(item)] + self.age[glob[grp]] / float(self.fps)
                out[lpos] = clip.frames(src_t)  # already placed into the box
        op = np.asarray(opacity, np.float32).reshape(-1)[:count, None, None]
        out[..., 3] = np.clip(out[..., 3].astype(np.float32) * op, 0, 255).astype(np.uint8)
        return out

    def close(self) -> None:
        for c in self.clips:
            if c is not None:
                c.close()


def video_src_times(count, fps, src0, speed) -> np.ndarray:
    """Source time (s) per output frame: `src_t[i] = src0 + (Σ speed before i) / fps`.
    speed >= 0, so the times are non-decreasing — what `VideoClip.frames` requires."""
    count = int(count)
    sp = np.maximum(0.0, np.asarray(speed, np.float64).reshape(-1))
    if sp.size < count:  # hold the last (or unit) speed if the array is short/scalar
        sp = np.concatenate([sp, np.full(count - sp.size, sp[-1] if sp.size else 1.0)])
    sp = sp[:count]
    return float(src0) + np.concatenate([[0.0], np.cumsum(sp)[:-1]]) / float(fps)


def apply_video_opacity(out: np.ndarray, opacity) -> np.ndarray:
    """Scale a video layer's alpha by the per-frame `opacity` array, in place."""
    op = np.asarray(opacity, np.float32).reshape(-1)[: out.shape[0], None, None]
    out[..., 3] = np.clip(out[..., 3].astype(np.float32) * op, 0, 255).astype(np.uint8)
    return out
