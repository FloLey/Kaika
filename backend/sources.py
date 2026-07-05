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

from . import fonts as _fonts

# key -> (min, max, default) per source card; mirrors lib/nodeParams.ts. The lyrics
# fill/outline colours come from wired `color` cards (default white/black); the text
# size + placement come from the box. So only `opacity` is a modulatable port. The
# image/video layer cards likewise expose only `opacity` (box/fit/timing are static).
SOURCE_PARAMS: dict[str, dict[str, tuple[float, float, float]]] = {
    "lyrics": {"opacity": (0.0, 1.0, 1.0)},
    "image": {"opacity": (0.0, 1.0, 1.0)},
    "video": {"opacity": (0.0, 1.0, 1.0), "speed": (0.0, 4.0, 1.0)},
    "backdrop": {"opacity": (0.0, 1.0, 1.0)},
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


def lyrics(nframes, h, w, fps, *, lines, seg_start, align, case, reveal,
           r, g, b, opacity, font="inter", box_x=0.05, box_y=0.08,
           box_w=0.9, box_h=0.84, outline=True, outline_width=0.12,
           outline_r=0.0, outline_g=0.0, outline_b=0.0, frame_offset=0) -> np.ndarray:
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
        line = next((ln for ln in lines if float(ln.get("t0", 0)) <= t < float(ln.get("t1", 0))), None)
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
            fit = fits[text] = _fit(
                text, font, bh, bw, bh, draw, outline_width if outline else 0.0
            )
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
        stroke = (int(_at(outline_r, i) * 255), int(_at(outline_g, i) * 255), int(_at(outline_b, i) * 255), 255)

        block_w, block_h = bbox[2] - bbox[0], bbox[3] - bbox[1]
        if align == "left":
            x0 = bx
        elif align == "right":
            x0 = bx + bw - block_w
        else:
            x0 = bx + (bw - block_w) // 2
        y0 = by + (bh - block_h) // 2  # centred vertically in the box
        draw.multiline_text(
            (x0 - bbox[0], y0 - bbox[1]), block, font=fnt, fill=fill, spacing=spacing,
            align=align, stroke_width=sw, stroke_fill=stroke,
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
    out[dy:dy + ch, dx:dx + cw] = r[sy:sy + ch, sx:sx + cw]
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


def image(nframes, h, w, *, asset_path, box_x=0.0, box_y=0.0, box_w=1.0, box_h=1.0,
          fit="cover", opacity, frame_offset=0) -> np.ndarray:
    """A still image as an RGBA layer `(nframes, h, w, 4)`. Placed into the box (fractions
    0..1, default full-frame) per `fit`; alpha = the image's own alpha × box coverage,
    scaled per frame by `opacity`. `frame_offset` is unused (static) — kept so the block
    renderer can call it the same way as `video`/`lyrics`."""
    base = np.zeros((h, w, 4), np.uint8)
    if asset_path:
        try:
            src = np.asarray(Image.open(asset_path).convert("RGBA"), np.uint8)
            x0, y0, bw, bh = _place_box(w, h, box_x, box_y, box_w, box_h)
            base[y0:y0 + bh, x0:x0 + bw] = _fit_rgba(src, bw, bh, fit)
        except (OSError, ValueError, Image.DecompressionBombError):
            pass  # missing/corrupt/oversized asset -> empty (transparent) layer
    return _apply_opacity(base, nframes, opacity)


@lru_cache(maxsize=128)
def _video_meta(path: str):
    """(duration_sec, width, height) for a video, via ffprobe (cached)."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height:format=duration", "-of", "json", path],
        capture_output=True, text=True)
    try:
        j = json.loads(out.stdout or "{}")
    except ValueError:
        return 0.0, 16, 16
    st = (j.get("streams") or [{}])[0]
    return float(j.get("format", {}).get("duration") or 0.0), int(st.get("width") or 16), int(st.get("height") or 16)


def _fit_vf(bw: int, bh: int, fit: str) -> str:
    """ffmpeg -vf fit chain producing exactly bw x bh RGBA (transparent letterbox for
    `contain`)."""
    if fit == "stretch":
        return f"scale={bw}:{bh}"
    if fit == "contain":
        return (f"scale={bw}:{bh}:force_original_aspect_ratio=decrease,"
                f"pad={bw}:{bh}:(ow-iw)/2:(oh-ih)/2:color=#00000000")
    return f"scale={bw}:{bh}:force_original_aspect_ratio=increase,crop={bw}:{bh}"  # cover


def video(count, h, w, fps, *, asset_path, box_x=0.0, box_y=0.0, box_w=1.0, box_h=1.0,
          fit="cover", loop=True, src0=0.0, speed=1.0, opacity) -> np.ndarray:
    """A video as an RGBA layer `(count, h, w, 4)`, placed into the box per `fit`.

    Timing is fully resolved by the caller (`graph._video_*`): `src0` is the source time
    (seconds) of output frame 0, and `speed` is a per-frame array — the source advances by
    `speed[i]/fps` each output frame, so a wired/modulated speed time-warps the clip
    (constant speed reduces to plain linear playback). Source frames are sampled at those
    (non-uniform) times from ONE decode of the covering span, resampled to the output rate
    (`-stream_loop -1` continues past the clip end when `loop`, else the last frame holds).
    Alpha = box coverage (transparent letterbox for `contain`) × `opacity`."""
    count = int(count)
    x0, y0, bw, bh = _place_box(w, h, box_x, box_y, box_w, box_h)
    out = np.zeros((count, h, w, 4), np.uint8)
    dur, _vw, _vh = _video_meta(str(asset_path)) if asset_path else (0.0, 16, 16)
    if not asset_path or count <= 0:
        return _apply_opacity(out[0] if count else np.zeros((h, w, 4), np.uint8), max(count, 1), opacity)[:count]

    sp = np.maximum(0.0, np.asarray(speed, np.float64).reshape(-1))
    if sp.size < count:  # hold the last (or unit) speed if the array is short/scalar
        sp = np.concatenate([sp, np.full(count - sp.size, sp[-1] if sp.size else 1.0)])
    sp = sp[:count]
    # Source time per output frame: src_t[i] = src0 + (Σ speed before i) / fps. speed>=0,
    # so src_t is non-decreasing and frame 0 is the earliest — its time is the decode seek.
    src_t = float(src0) + np.concatenate([[0.0], np.cumsum(sp)[:-1]]) / float(fps)
    if dur > 0 and loop:  # periodic: fold the seek into [0, dur); stream_loop covers overruns
        src_t = src_t - np.floor(src_t[0] / dur) * dur
    elif dur > 0:  # no loop: hold the last frame once past the end
        src_t = np.clip(src_t, 0.0, max(0.0, dur - 1.0 / float(fps)))
    seek = float(src_t[0])
    nsrc = int(np.ceil((src_t[-1] - seek) * fps)) + 2  # decode the span at the output grid rate

    # NO `-t` (an output-duration cap clips frames when speed<1 -> slow-motion freeze); the
    # `fps` filter resamples the source onto the output grid so index math is uniform.
    cmd = ["ffmpeg", "-v", "error"]
    if loop:
        cmd += ["-stream_loop", "-1"]
    cmd += ["-ss", f"{max(0.0, seek):.4f}", "-i", str(asset_path),
            "-vf", f"fps={fps},format=rgba,{_fit_vf(bw, bh, fit)}",
            "-frames:v", str(nsrc), "-pix_fmt", "rgba", "-f", "rawvideo", "-"]
    proc = subprocess.run(cmd, capture_output=True)
    buf = np.frombuffer(proc.stdout, np.uint8)
    got = buf.size // (bw * bh * 4)
    if got:
        dframes = buf[: got * bw * bh * 4].reshape(got, bh, bw, 4)
        idx = np.clip(np.round((src_t - seek) * fps).astype(int), 0, got - 1)  # nearest source frame
        out[:, y0:y0 + bh, x0:x0 + bw, :] = dframes[idx]
    op = np.asarray(opacity, np.float32).reshape(-1)[:count, None, None]
    out[..., 3] = np.clip(out[..., 3].astype(np.float32) * op, 0, 255).astype(np.uint8)
    return out
