# 12 — Plasma   `[gen]` · effort 🟢 · Geometric / retro-viz

## Concept

The demoscene plasma: smooth flowing fields of colour born from a handful of
summed sinusoids, endlessly morphing, hypnotic and almost free to compute. The
oldest trick in real-time graphics, and still one of the most satisfying beds to
put behind lyrics. Reads as a slow lava-lamp wash at rest and a fast, tight,
high-contrast psychedelic churn when pushed.

**Elegant↔energetic range:** large `scale` + slow `speed` + low `contrast` = big
soft gradients drifting like oil on water; small `scale` + fast `speed` + high
`contrast` + strong `warp` = a strobing rainbow kaleidoscope of tight cells.

## Signal map

| Signal | Natural target |
|---|---|
| `energy` (any stem) | `scale` — loudness tightens the field |
| `chroma` | `hue` shift — the dominant pitch class rotates the palette |
| `flux` | `warp` — busier music distorts the field harder |
| `bar` | `speed` — the flow phase advances over the bar |

## Ports

| key | label | range | default | effect |
|---|---|---|---|---|
| `scale` | scale | 0.2..4 | 1.0 | spatial frequency of the sinusoids (zoom) |
| `speed` | speed | 0..4 | 1.0 | time advance of the flow |
| `warp` | warp | 0..1 | 0.2 | domain distortion (self-warping the coordinates) |
| `hue` | hue | 0..1 | 0.0 | palette rotation |
| `contrast` | contrast | 0..1 | 0.4 | softness ↔ hardness of the colour bands |
| `opacity` | opacity | 0..1 | 1.0 | layer alpha |

## Static data

- `palette`: `"rainbow"` / `"duotone"` / `"pastel"` / `"mono"` — the colour LUT
  the scalar field is mapped through; `hue` rotates within it.
- `seed`: int — perturbs the sinusoid frequencies/phases so two plasmas differ.

## Backend algorithm

Fully stateless — the field is a closed form in `t = frame_index / fps`, so it
copies `backdrop` (whole-clip + block handler, no `FluidClip`). This is the
cheapest card in the catalog.

1. **Precompute the grid** `(Y, X)` once (normalized `[-1,1]`), scaled by
   `scale`.
2. **Classic plasma sum** — a few terms, all seeded from `seed`:
   `p = sin(a·X + speed·t) + sin(b·Y + speed·t·1.3) + sin(c·(X+Y) + speed·t·0.7)
   + sin(hypot(X − cx(t), Y − cy(t)))`, where `(cx, cy)` is a slowly circling
   centre `= (sin(speed·t·0.4), cos(speed·t·0.3))`. Normalize `p` to 0..1.
3. **Domain warp** (optional, `warp > 0`): offset the sample coordinates by a
   cheap value-noise field (reuse the `noise` modulator's helper) scaled by
   `warp` before step 2 — self-distorts the plasma so it stops looking like clean
   stripes.
4. **Colour**: index the palette LUT by `frac(p + hue)`; `contrast` pushes `p`
   through a smoothstep (soft gradient ↔ hard posterized bands) first. Alpha =
   `opacity`. Return `(nframes, h, w, 4)` uint8.

Pure vectorised numpy — a 1080p frame is ~4 `sin` over a `(H, W)` array plus one
LUT gather. Nothing is carried between frames or blocks.

## Frontend card

Copy `BackdropNode.tsx` + a `palette` `<select>`. Full-frame, no BoxPad.

## Template & effort

Copy **`backdrop`**. 🟢 — textbook stateless field, no geometry, no asset.

## Playground demo

`plasma` → `output`, `energy` → `scale`, `chroma` → `hue`. No asset needed.

## Variants / open questions

- Expose the number of sinusoid terms as static data (more terms = busier field)
  — or keep it fixed at 4 for a recognizable look.
- A `symmetry` fold (mirror the field) for a kaleidoscope plasma — overlaps the
  `transform` kaleidoscope, so probably leave it to a downstream `[fx]`.
- Great base layer: put it under any `[fx]` card (pixel-sort, mosaic) for a
  colourful feedstock.
