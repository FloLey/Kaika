# 07 — Cymatics   `[gen]` · effort 🟡 · Sound-native

## Concept

A driven plate seen from directly above, dusted with fine sand: the vibration
cancels along the plate's nodal lines, so the grains slide off the antinodes and
pile up into the standing-wave figure — the intricate, mirror-symmetric Chladni
pattern. As the driving frequency shifts, the plate jumps between modes and the
whole figure re-forms into a new lattice. The shape literally **is** the pitch,
which is exactly the point for a music app.

**Elegant↔energetic range:** a low `frequency` picks a simple low-mode figure
(a cross, a ring) that morphs slowly and holds still; high `frequency` + high
`grain` + low `sharpness` gives a dense, high-order lattice shivering with
scatter as `energy` throws the grains around.

## Signal map

| Signal | Natural target |
|---|---|
| `brightness` | `frequency` — pitch height selects the mode numbers `(m, n)` |
| `chroma` | `frequency` fine-detune — pitch class nudges the figure between neighbours |
| `energy` | scatter amplitude — louder = grains rattle wider off the nodes |
| `harmonic` | `sharpness` — tonal passages tighten the lines, noise blurs them |
| `beat` | mode-change trigger — quantise figure jumps to the beat |

## Ports

| key | label | range | default | effect |
|---|---|---|---|---|
| `frequency` | frequency | 0..1 | 0.3 | drives the mode numbers `(m, n)` — the figure selected |
| `symmetry` | symmetry | 1..8 | 1 | extra rotational folding of the field (kaleidoscopic mirroring) |
| `grain` | grain | 0..1 | 0.5 | particle density gathered on the node lines |
| `sharpness` | sharpness | 0..1 | 0.6 | nodal-line width / falloff (thin crisp ↔ soft broad) |
| `glow` | glow | 0..1 | 0.3 | additive gaussian bloom on the grains |
| `hue` | hue | 0..1 | 0.12 | grain colour through the palette |
| `opacity` | opacity | 0..1 | 1.0 | layer alpha |

## Static data

- `shape`: `"square"` / `"circular"` / `"rectangular"` — the plate boundary,
  which sets the eigenmode family (product-of-cosines for square/rect, Bessel
  rings for circular).
- `palette`: named ramp for the grains over the plate ground.
- `seed`: int — seeds the particle jitter so two cards differ.

## Backend algorithm

Fully analytic, stateless field → copies `backdrop` (whole-clip + block, no
`FluidClip`); the figure at frame `i` is a pure function of that frame's port
values.

1. Precompute a normalized grid `(Y, X)` once (`np.meshgrid`, 0..1).
2. **Mode selection**: map `frequency` (0..1) onto integer mode numbers
   `(m, n)` — e.g. quantise into a table of ascending `(m, n)` pairs so rising
   pitch climbs to higher-order figures. `chroma`/`beat` can bias the choice.
3. **Chladni field** for a square plate: the nodal figure is the antisymmetric
   combination `F = cos(mπX)·cos(nπY) − cos(nπX)·cos(mπY)`; nodes are where
   `|F| < ε`. (Circular/rectangular swap in the matching eigenfunctions.)
   Apply `symmetry` by folding `(X, Y)` into a wedge before evaluation.
4. **Grain scatter**: sample candidate points and **reject** any where
   `|F| > threshold(sharpness)`, so survivors cluster on the node lines;
   `grain` sets how many candidates → density. Displace each survivor by a
   small `energy`-scaled jitter (from `seed + frame_index`) so loud passages
   rattle the sand. Splat the survivors into an RGBA scratch.
5. **Shade**: colour grains from `hue`/palette; add a gaussian-blurred copy
   (`scipy.ndimage`) for `glow`. Alpha = coverage × `opacity`. Return
   `(nframes, h, w, 4)` uint8.

All per-frame ops are vectorised numpy; the field is a handful of `cos` over a
`(H, W)` array and the scatter is a boolean mask + gather.

## Frontend card

Copy `BackdropNode.tsx`: `NodeFrame` with a `video` out port and
`NODE_PARAMS.map(ParamRow)`. Add a `shape` `<select>` and a `palette` `<select>`
bound to `data` (like the video card's `fit` select). No BoxPad (full-frame).

## Template & effort

Copy **`backdrop`**. 🟡 not 🟢 because of the mode-number quantisation, the
reject-sampling scatter and the glow pass — real drawing work — but there is no
sim state and no asset, so streaming is trivial (`frame_offset` → the frame's
port slice).

## Playground demo

`cymatics` → `output`, `brightness` → `frequency`, `energy` (drums) → `grain`.
Square plate, default palette. No asset needed.

## Variants / open questions

- A `plate_glow` that lights the antinodes faintly (inverse of the node mask)
  for a "resonance heat-map" read alongside the grains.
- Continuous mode **morphing**: interpolate the field between two `(m, n)` pairs
  instead of hard-switching, so figures dissolve rather than jump — nicer on
  sustained pitch glides, still stateless.
- `circular` plate opens Bessel-ring figures that read very differently — worth
  shipping all three shapes as one card via the `shape` static.
