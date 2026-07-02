"""Non-fluid video SOURCE cards (spec 04): -> dye layers for the compositor.

These synthesise a video stream from scratch (no fluid sim) so they can be layered with
fluids via a stack combine or sent straight to an output. The `lyrics` card returns an
RGBA layer `(T, H, W, 4)` — its alpha is the glyph+outline coverage, so a black outline
truly occludes the fluid beneath it (`graph.composite` / `fluid.apply_background` both
honour a 4-channel layer's alpha). `SOURCE_PARAMS` mirrors the modulatable ranges in
lib/nodeParams.ts; the box/outline/font are static `data` fields.
"""

from __future__ import annotations

from functools import lru_cache

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from . import fonts as _fonts

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


def _fit(text, key, px0, box_w, box_h, draw):
    """Shrink the font from `px0` until the wrapped lines fit BOTH the box width (wrap)
    and height. Returns (font, px, lines, line_h)."""
    px = max(8, int(px0))
    while True:
        font = _font(px, key)
        lines = _wrap(text, font, box_w, draw)
        asc, desc = font.getmetrics()
        line_h = int((asc + desc) * 1.18)
        total_h = line_h * len(lines)
        widest = max((draw.textlength(ln, font=font) for ln in lines), default=0)
        if px <= 8 or (total_h <= box_h and widest <= box_w):
            return font, px, lines, line_h
        px = max(8, int(px * 0.9) if px > 24 else px - 1)


def lyrics(nframes, h, w, fps, *, lines, seg_start, position, align, case, reveal,
           size, r, g, b, opacity, font="inter", box_x=0.05, box_y=0.08,
           box_w=0.9, box_h=0.84, outline=True, outline_width=0.12,
           frame_offset=0) -> np.ndarray:
    """Render the segment's aligned lyric lines as a timed RGBA dye layer. `lines`
    = [{t0, t1, text}] in ABSOLUTE song time; `seg_start` offsets each frame into the
    clip. With reveal="word" the active line fills in word-by-word over its [t0, t1].

    Text word-wraps and auto-shrinks to fit the box (`box_x/y/w/h`, fractions 0..1);
    `align` justifies horizontally and `position` places vertically WITHIN the box.
    `outline` draws a black stroke (width = `outline_width` * font px) under a white
    fill so the text stays readable over anything — the returned alpha covers both.

    `frame_offset` is the absolute clip-frame index of the FIRST rendered frame, so the
    block renderer can synthesize just frames [frame_offset, frame_offset+nframes) while
    the per-frame `size/r/g/b/opacity` arrays are the matching sliced ranges."""
    out = np.zeros((nframes, h, w, 4), np.uint8)  # RGBA: alpha = glyph+outline coverage
    if not lines:
        return out
    dt = 1.0 / float(fps or 24)
    bx, by = int(box_x * w), int(box_y * h)
    bw, bh = max(1, int(box_w * w)), max(1, int(box_h * h))
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

        img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        fnt, px, wrapped, line_h = _fit(text, font, float(size[i]) * h, bw, bh, draw)
        sw = max(0, int(outline_width * px)) if outline else 0
        fill = (int(r[i] * 255), int(g[i] * 255), int(b[i] * 255), 255)
        stroke = (0, 0, 0, 255)

        total_h = line_h * len(wrapped)
        if position == "top":
            y = by
        elif position == "center":
            y = by + (bh - total_h) // 2
        else:  # bottom
            y = by + bh - total_h
        for ln in wrapped:
            lw = draw.textlength(ln, font=fnt)
            if align == "left":
                x = bx
            elif align == "right":
                x = bx + bw - lw
            else:
                x = bx + (bw - lw) / 2
            draw.text((x, y), ln, font=fnt, fill=fill, stroke_width=sw, stroke_fill=stroke)
            y += line_h

        arr = np.asarray(img, np.uint8).copy()
        op = float(opacity[i])
        if op < 1.0:
            arr[..., 3] = (arr[..., 3].astype(np.float32) * op).astype(np.uint8)
        out[i] = arr
    return out
