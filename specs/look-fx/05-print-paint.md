# 05 — Print & Paint card (`video → video`)

> The stream as ink and pigment: newspaper halftone dots, a cel-shaded comic,
> a pencil sketch with cross-hatching, or an oil-paint smear. Lands last: it
> carries the wave's only dependency change (opencv-contrib for oil) and the
> reduced-resolution path for the two heavy modes, both isolated in one commit.

## Locked decisions

1. **Four modes**: `halftone | comic | sketch | oil` (default `halftone`).
2. **The dependency swap is guarded twice.** `requirements.txt`:
   `opencv-python-headless==5.0.0` → `opencv-contrib-python-headless==5.0.0`
   (same version, adds `cv2.xphoto`). The oil handler still checks
   `hasattr(cv2, "xphoto")` and falls back to a numpy Kuwahara-style mode
   filter (quantize luminance to ~8 buckets, `scipy.ndimage.uniform_filter`
   per bucket, take each pixel's dominant bucket's mean colour) — the card
   never 500s even on an un-upgraded env. **Risk**: the contrib wheel for
   macOS arm64 / the venv's Python must be verified at `make install` time; if
   unavailable, ship fallback-only and drop the swap (the look is close).
3. **Heavy modes run at reduced resolution** (PLAN §9): comic and oil apply
   through `look_fx._at_reduced(frame, fn, max_side=320)` — `INTER_AREA` down,
   effect, `INTER_LINEAR` up. Halftone and sketch run at full res (cheap).
4. **Sketch needs no contrib**: the classic dodge blend
   (`gray / (255 − blur(255−gray))`) + Sobel-oriented hatch darkening — fast,
   dependency-free, and reads as pencil. (`cv2.pencilSketch` exists in core cv2
   but its look is fixed; the dodge variant keys stroke density off `scale`.)
5. **Floor**: halftone/sketch/oil keep black black (no dots / no strokes / dark
   daubs on dark). Comic's bilateral can lift near-black slightly — acceptable,
   noted in paramHelp, not worth masking.

## Data + ports

```ts
export interface PaintData {
  mode: "halftone" | "comic" | "sketch" | "oil";
  ports: Record<string, FluidPort>;
}
```

`SOURCE_PARAM_SPEC["paint"]`:

| key | label | min | max | step | default | fmt |
|-----|-------|-----|-----|------|---------|-----|
| `scale` | scale | 0.005 | 0.08 | 0.002 | 0.02 | dp3 |
| `strength` | strength | 0.0 | 1.0 | 0.01 | 1.0 | dp2 |

Port → mode mapping:

| port | halftone | comic | sketch | oil |
|------|----------|-------|--------|-----|
| `scale` | dot pitch (·H px) | smoothing + posterize coarseness | stroke blur radius | brush size |
| `strength` | dry ↔ dots mix | mix + edge darkness + level count (8→3) | mix + hatch density | dry ↔ paint mix |

## 1 — `backend/look_fx.py`

```python
def _at_reduced(frame, fn, max_side=320) -> np.ndarray  # shared helper (comic, oil)
def paint_apply(frames, static, fps, frame_offset, *, scale, strength):
```

- **halftone**: luminance area-meaned to the `scale` cell grid → per-cell dot
  radius ∝ √luminance (area-linear ink) → compare the `np.repeat`-upsampled
  radius map against a precomputed tiled distance-to-cell-centre map
  (`lru_cache` per cell px) → white-on-black dots; lerp by `strength`.
  Pure numpy.
- **comic**: `cv2.bilateralFilter` (d from `scale`), per-channel posterize to
  `8 − round(strength·5)` levels, `cv2.Canny` edges drawn black on top; via
  `_at_reduced`.
- **sketch**: dodge blend (Locked 4) at full res; Sobel magnitude/orientation
  darkens along quantized hatch directions, density from `strength`, blur
  radius from `scale`.
- **oil**: `cv2.xphoto.oilPainting(size from scale, dynRatio=1)` when present,
  else the Kuwahara fallback (Locked 2); via `_at_reduced`; lerp by `strength`.
- RGB-only modes (comic, oil) flatten RGBA input via `fluid.flatten` first
  (the `_extract_video` precedent); halftone/sketch operate on luminance and
  re-tint, alpha passed through.

## 2 — Backend handlers

Stateless transform pair — `_paint_video` / `_paint_block`. Register in both
dicts.

## 3–4 — Frontend

Standard wiring (spec 01 §3). `normalize.ts`: `mode: oneOf(..., "halftone")`.
`PaintNode.tsx`: mode select + two `ParamRow`s (the simplest multi-mode card).
Registry label "Print & Paint", order 3.65, help: "Halftone dots, comic
shading, pencil sketch or oil paint. Wire scale to a signal — the dots breathe
with the music."

## 5 — Playground demo + tests

- `CARD_LABELS`: `"paint": "Print & Paint"`. Demo: bright fluid → paint
  (halftone, `scale` ← LFO) → output — pulsing dots; a bright input keeps the
  white-dot coverage above the `lit >= 0.5%` floor.
- `tests/test_look_fx.py` additions:
  - halftone: black in → black out; full-white in → dot coverage ≈ the packing
    fraction (sanity-bounds, not exact);
  - `strength=0` → passthrough for all four modes;
  - oil: runs (and differs from input) whether or not `cv2.xphoto` is present
    — parameterized over the guard by monkeypatching `hasattr`'s target;
  - comic at 4-channel input → 3-channel handling documented by the flatten
    assertion;
  - stream ≡ sync for halftone (stateless slice proof).
- Perf gate (informal, in the PR): comic + oil on a 24-frame 360p block well
  under the block render budget — the `_at_reduced` path keeps them O(320²).

## Verification

Commit gates (PLAN) **plus**: `make install` on a clean venv confirms the
contrib wheel resolves (Locked 2's risk); `python -c "import cv2;
print(hasattr(cv2, 'xphoto'))"` → True. Live: all four modes; halftone dots
breathing on the LFO; comic/oil preview stays fluid at draft quality.
