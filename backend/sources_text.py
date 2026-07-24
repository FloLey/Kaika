"""Source cards that draw TEXT: the `lyrics` layer and its font/wrap/fit machinery.

Split out of `sources.py` (cleanup step 27). Import from the `sources` facade unless
you are working inside the package.

`lyrics` returns RGBA `(T, H, W, 4)` — the alpha is glyph+outline coverage, so a black
outline truly occludes the fluid beneath it (`graph.composite` / `fluid.flatten` both
honour a 4-channel layer's alpha). The box/outline/font are static `data` fields.
"""

from __future__ import annotations

from functools import lru_cache

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from . import fonts as _fonts
from .sources_common import _at


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


def _fit(text, key, px0, box_w, box_h, draw, stroke_frac, px_min=8):
    """Shrink the font from `px0` until the wrapped text block — INCLUDING its outline
    stroke — actually fits inside the box (both width and height). Measured with PIL's
    own `multiline_textbbox` (which accounts for `stroke_width`) so the fit matches what
    `multiline_text` draws — otherwise the stroke makes the text overflow. Stops at
    `px_min` even if the block still overflows (the card's min-size promise beats the
    box: readable-but-clipped over unreadable). Returns
    (font, px, block, stroke_px, spacing, bbox)."""
    px = max(px_min, int(px0))
    while True:
        font = _font(px, key)
        sw = max(0, int(stroke_frac * px))
        spacing = max(0, int(px * 0.15))  # gap between wrapped lines
        # Wrap to the width left after the stroke eats `sw` px on each side.
        lines = _wrap(text, font, box_w - 2 * sw, draw)
        block = "\n".join(lines)
        bbox = draw.multiline_textbbox((0, 0), block, font=font, spacing=spacing, stroke_width=sw)
        if px <= px_min or (bbox[2] - bbox[0] <= box_w and bbox[3] - bbox[1] <= box_h):
            return font, px, block, sw, spacing, bbox
        px = max(px_min, int(px * 0.9) if px > 24 else px - 1)


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
    size_min=0.0,
    size_max=1.0,
    frame_offset=0,
) -> np.ndarray:
    """Render the segment's aligned lyric lines as a timed RGBA dye layer. `lines`
    = [{t0, t1, text}] in ABSOLUTE song time; `seg_start` offsets each frame into the
    clip. With reveal="word" the active line fills in word-by-word over its [t0, t1].

    Text word-wraps and auto-shrinks to fill the box (`box_x/y/w/h`, fractions 0..1) —
    the box defines both size and placement — and is centred vertically within it.
    `size_min`/`size_max` clamp the auto-fit, as fractions of the FRAME height
    (resolution-independent, like the box): `size_max` caps how large a short line may
    grow, `size_min` floors how small a long line may shrink — and wins over the box
    (readable-but-clipped beats unreadable). Defaults (0.0 / 1.0) reproduce the
    unclamped fit exactly, so cards without the fields keep their output;
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
            # The auto-fit's start/floor, clamped by the card's size limits (fractions
            # of the frame height `th` — the same resolution-independence as the box).
            px0 = min(bh, max(1, int(round(size_max * th))))
            px_min = max(8, int(round(size_min * th)))
            fit = fits[text] = _fit(
                text, font, px0, bw, bh, draw, outline_width if outline else 0.0, px_min
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
