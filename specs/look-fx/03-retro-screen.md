# 03 — Retro Screen card (`video → video`)

> The stream re-rendered as an old display: ASCII terminal glyphs, Matrix-style
> glyph rain revealing the video, chunky 8-bit pixels (with optional Game
> Boy / NES palettes), or a stadium LED wall. The wave's biggest pixel-math
> surface; lands third, once the seams are proven.

## Locked decisions

1. **Four modes**: `ascii | matrix | pixelate | led` (default `ascii`).
2. **Glyphs come from a pre-rendered atlas, not per-cell text calls.** The ramp
   `" .:-=+*#%@"` is rendered ONCE per cell pixel size with PIL through the
   existing bundled-font loader (`sources._font`, `backend/fonts.py` — the
   lyrics machinery; pillow is already a dependency) into a
   `(n_glyphs, ph, pw)` uint8 array, `lru_cache`d on the quantized size. A
   frame is then: area-downsample luminance to the cell grid → bucket to glyph
   index → `atlas[idx]` fancy-index → `transpose(0,2,1,3).reshape(...)` → crop
   to `(H, W)`. Fully vectorized; no per-cell loop, no unbounded cache (PLAN §9).
3. **Matrix rain is a pure function of the absolute frame index** (PLAN §2's
   second shape): per-column phase/speed/activation are fixed arrays drawn once
   from `default_rng(seed)` at closure build; frame `t_abs` computes head
   positions analytically (`(t_abs/fps · speed · jitter + phase) mod (H +
   trail)`). Any block — and the sync path — computes identical frames; no
   state.
4. **`cell` is a fraction of frame height** (resolution-independent: preview
   and HD export show the same look): `px = max(2, round(cell · H))`.
5. **Floor**: all four modes keep black black (luminance 0 → space glyph / no
   rain lit / black cell / dark LED).

## Data + ports

```ts
export interface RetroData {
  mode: "ascii" | "matrix" | "pixelate" | "led";
  colorMode: "green" | "mono" | "original"; // ascii only
  palette: "none" | "gameboy" | "nes";      // pixelate only
  seed: number;                             // matrix only
  ports: Record<string, FluidPort>;
}
```

`SOURCE_PARAM_SPEC["retro"]`:

| key | label | min | max | step | default | fmt |
|-----|-------|-----|-----|------|---------|-----|
| `cell` | cell size | 0.01 | 0.15 | 0.005 | 0.03 | dp2 |
| `amount` | amount | 0.0 | 1.0 | 0.01 | 1.0 | dp2 |
| `speed` | speed | 0.0 | 4.0 | 0.05 | 1.0 | dp2 |

Port → mode mapping:

| port | ascii | matrix | pixelate | led |
|------|-------|--------|----------|-----|
| `cell` | glyph cell px | column width + glyph size | mosaic block px | LED pitch |
| `amount` | dry ↔ effect mix | rain density (fraction of active columns) | dry ↔ effect mix | dot fill ratio |
| `speed` | — (no-op, in paramHelp) | fall speed multiplier | — | — |

Wire `cell` to a kick signal and the resolution pumps on every hit — the
card's headline trick.

## 1 — `backend/look_fx.py`

```python
@lru_cache(maxsize=32)
def glyph_atlas(px: int, ramp: str = " .:-=+*#%@") -> np.ndarray  # (n, ph, pw) uint8

def retro_apply(frames, static, fps, frame_offset, *, cell, amount, speed):
```

- **ascii**: atlas assembly (Locked 2). Colouring: `green` = glyph luminance ×
  `(0.2, 1.0, 0.35)`; `mono` = white; `original` = glyph coverage × the cell's
  mean colour (`np.repeat` upsample).
- **matrix**: analytic columns (Locked 3) at cell resolution; per-pixel
  brightness `clip(1 − (y_head − y)/trail, 0, 1)` above the head; mask × the
  green-shifted input + bright glyph heads (atlas reused). `amount` gates
  columns by thresholding their fixed uniform draw — modulating it makes rain
  come and go without breaking determinism.
- **pixelate**: `cv2.resize INTER_AREA` down to the cell grid (reshape-mean on
  the divisible fast path), nearest back up. `palette`: squared-distance
  `argmin` against 4 Game Boy greens / a 16-colour NES subset (tiny palettes —
  cheap).
- **led**: pixelate to the grid, multiply by a tiled circular dot mask
  (precomputed per `(cell_px, radius)`, radius = `amount`-scaled) on black.

## 2 — Backend handlers

Stateless transform pair — `_retro_video` / `_retro_block` (params sliced
`[a:b]`, `frame_offset=a`). Register in both dicts.

## 3–4 — Frontend

Standard wiring (spec 01 §3). Deltas: `normalize.ts` row with three `oneOf`s +
`seed: num(1)`; `RetroNode.tsx` shows `colorMode`/`palette`/`seed`
mode-conditionally (transform's `segments` pattern); registry label
"Retro Screen", order 3.61, help: "ASCII terminal, Matrix rain, 8-bit pixels or
an LED wall. Wire cell size to a signal — the resolution pumps with the beat."

## 5 — Playground demo + tests

- `CARD_LABELS`: `"retro": "Retro Screen"`. Demo: bright fluid → retro
  (matrix, `cell` ← signal) → output; matrix heads render bright (clears the
  floors).
- `tests/test_look_fx.py` additions:
  - matrix determinism: same seed twice → identical; different seed → differs;
  - **stream ≡ sync** for matrix (block_frames=4) — the analytic-trajectory
    proof;
  - ascii on a black frame → black; pixelate `amount=0` → passthrough;
  - `glyph_atlas` shape/dtype + cache hit (same object back);
  - RGBA input accepted (flatten path).

## Verification

Commit gates (PLAN). Live: all four modes on a busy fluid; `cell` wired to a
kick — visible resolution pumping; matrix across a block seam — columns don't
jump.
