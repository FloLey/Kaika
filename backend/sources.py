"""Non-fluid video SOURCE cards (spec 04): -> dye-on-black frames `(T, H, W, 3)`.

These synthesise a video stream from scratch (no fluid sim) so they can be layered with
fluids via a stack combine or sent straight to an output. Same frame contract as
`fluid.simulate` (uint8, dye-on-black) so `graph.composite` / `apply_background` work
unchanged. `SOURCE_PARAMS` mirrors the modulatable ranges in lib/nodeParams.ts.
"""

from __future__ import annotations

import numpy as np
from PIL import Image, ImageDraw, ImageFont

# key -> (min, max, default) per source card; mirrors lib/nodeParams.ts.
SOURCE_PARAMS: dict[str, dict[str, tuple[float, float, float]]] = {
    "lyrics": {
        "size": (0.03, 0.2, 0.08),
        "r": (0.0, 1.0, 1.0),
        "g": (0.0, 1.0, 1.0),
        "b": (0.0, 1.0, 1.0),
        "opacity": (0.0, 1.0, 1.0),
    },
}


def _font(px: int):
    """A bold TrueType font at `px`, falling back to PIL's bundled default so no asset
    is required (and the render stays reproducible)."""
    for name in ("DejaVuSans-Bold.ttf", "Arial Bold.ttf", "Arial.ttf"):
        try:
            return ImageFont.truetype(name, px)
        except OSError:
            continue
    try:
        return ImageFont.load_default(px)  # PIL >= 10 scalable default
    except (TypeError, AttributeError):
        return ImageFont.load_default()


def lyrics(nframes, h, w, fps, *, lines, seg_start, position, align, case, reveal,
           size, r, g, b, opacity, frame_offset=0) -> np.ndarray:
    """Render the segment's aligned lyric lines as a timed dye-on-black layer. `lines`
    = [{t0, t1, text}] in ABSOLUTE song time; `seg_start` offsets each frame into the
    clip. With reveal="word" the active line fills in word-by-word over its [t0, t1].

    `frame_offset` is the absolute clip-frame index of the FIRST rendered frame, so
    the block renderer can synthesize just frames [frame_offset, frame_offset+nframes)
    while the per-frame `size/r/g/b/opacity` arrays are the matching sliced ranges."""
    out = np.zeros((nframes, h, w, 3), np.uint8)
    if not lines:
        return out
    dt = 1.0 / float(fps or 24)
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
        if reveal == "word":
            words = text.split()
            t0 = float(line.get("t0", 0.0))
            t1 = max(t0 + 0.1, float(line.get("t1", t0 + 1.0)))
            frac = max(0.0, min(1.0, (t - t0) / (t1 - t0)))
            text = " ".join(words[: max(1, int(np.ceil(frac * len(words))))])

        px = max(8, int(float(size[i]) * h))
        img = Image.new("RGB", (w, h), (0, 0, 0))
        draw = ImageDraw.Draw(img)
        font = _font(px)
        bbox = draw.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        if tw > w * 0.95 and tw > 0:  # shrink to fit the frame width
            px = max(8, int(px * w * 0.95 / tw))
            font = _font(px)
            bbox = draw.textbbox((0, 0), text, font=font)
            tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        if align == "left":
            x = int(w * 0.04)
        elif align == "right":
            x = w - tw - int(w * 0.04)
        else:
            x = (w - tw) // 2
        if position == "top":
            y = int(h * 0.08)
        elif position == "center":
            y = (h - th) // 2
        else:  # bottom
            y = int(h * 0.86) - th
        op = float(opacity[i])
        fill = (int(r[i] * 255 * op), int(g[i] * 255 * op), int(b[i] * 255 * op))
        draw.text((x - bbox[0], y - bbox[1]), text, font=font, fill=fill)
        out[i] = np.asarray(img, np.uint8)
    return out
