# 23 — Mosaic tile-flip   `[fx]` · effort 🟡 · Video→video FX

## Concept

The incoming frames are diced into an R×C grid, and each tile shows the input
region under it — but the tiles **flip, rotate, scale, and pop on the beat**,
the flips sweeping across the grid in waves (row by row, out from the centre, on
the diagonal). It reads like a departure-board split-flap display, a shutter
wall, or a Rubik face reshuffling: the picture is always there, but delivered in
a rippling shuffle of little animated panels. Because it's an `[fx]` card it
tiles *whatever is wired in* — a photo, a clip, a live fluid.

Each tile's animation phase is a deterministic function of the beat signal plus
a per-tile offset from the chosen wave, so no two tiles hit at once and the whole
grid breathes as a travelling front.

**Elegant↔energetic range:** a coarse grid (4×4) with a slow radial wave and
gentle `scale` = tiles softly breathing in sequence like a slow-motion domino
fall; a fine grid (10×10) with `flip` firing every onset and heavy `jitter` =
every panel snapping and clattering on each hit, a frantic split-flap storm.

## Signal map

| Signal | Natural target |
|---|---|
| `beat` / `onset` | `flip` — a rising edge launches the next wave of flips |
| `energy` | `scale` — tiles pop bigger on louder passages |
| `flux` | `jitter` — busier spectrum shakes the tiles |
| `chroma` | `tint` — dominant pitch class colours the panels |

## Ports

| key | label | range | default | effect |
|---|---|---|---|---|
| `flip` | flip | 0..1 | 0.0 | rising past 0.5 launches the next flip wave (edge-triggered) |
| `jitter` | jitter | 0..0.2 | 0.0 | random per-tile positional shake (fraction of tile) |
| `scale` | pop | 0.5..1.5 | 1.0 | per-tile scale about its centre (pop on hits) |
| `gap` | gap | 0..0.1 | 0.01 | spacing between tiles (fraction of tile) |
| `radius` | corner | 0..0.3 | 0.05 | tile corner rounding |
| `tint` | tint | 0..1 | 0.0 | colour wash strength (hue from `chroma`) |
| `opacity` | opacity | 0..1 | 1.0 | layer alpha |

## Static data

- `rows`, `cols`: int (2..12 each).
- `motion`: `"flip-x"` / `"flip-y"` (split-flap about a horizontal / vertical
  axis), `"rotate"` (spin in-plane 0→180°), `"scale"` (shrink-to-zero and back),
  `"shuffle"` (swap the tile's content with a neighbour mid-wave).
- `wave`: `"row"` / `"col"` / `"diagonal"` / `"radial"` — the sweep pattern that
  sets each tile's phase offset across the grid.
- `seed`: int (jitter + shuffle RNG — derive from seed only, never wall-clock, so
  a render is reproducible and streaming-consistent).

## Backend algorithm

`[fx]` copying `transform`; every tile's state is derived analytically from the
beat phase and the tile index, so there is **no per-block state** — frame `i`
maps to a deterministic grid.

1. `src = _video_source(dag.graph, node["id"], "video")`; if `None` raise
   `ValueError`. Whole-clip `frames = dag.video(src)`; block
   `producer = dag._block_producer(src)`, `params = dag._fx_params(node)`.
   A `_tileflip_static(data)` reads rows/cols/motion/wave/seed.
2. **Wave phase per tile.** Precompute a normalised offset `φ(r,c) ∈ [0,1]` from
   `wave` (row → `r/R`; radial → distance from centre; diagonal → `(r+c)`). Each
   rising edge in the full-segment `flip` array marks a wave launch frame; a
   tile's local flip progress at frame `i` is `ease(t − φ(r,c)·spread)` for the
   most recent launch, clamped to `[0,1]`. This is pure arithmetic on `i`.
3. **Render frame `i`.** For each cell, copy the source region
   `frames[i][r-band, c-band]` into its destination cell (numpy slice), then apply
   the tile transform: a mid-flip tile is drawn **squashed toward its axis**
   (`flip-x` scales height by `|cos(π·progress)|`, revealing the back half past
   90° — the same glide-squash trick taquin uses for an in-flight tile);
   `rotate`/`scale` map to a per-tile affine (PIL `Image.transform` or a numpy
   remap). Apply `jitter·seed` offset, `scale` pop, rounded-rect clip for
   `radius`/`gap`, and a `tint` hue wash.
4. Output RGBA — carry the input's alpha, or opaque where the input is
   dye-on-black `(T,H,W,3)`. `opacity` scales alpha.

The per-tile copy loop and the affine/squash math are the only real work; both
vectorise cleanly over the grid, and `argsort`-free per-frame cost is
O(rows·cols) small blits.

## Frontend card

Copy `TransformNode.tsx` (has a video input + a mode `<select>`). Add
`rows`/`cols` number inputs and the `motion` + `wave` selects. `flip` is a
trigger port — document in `paramHelp` like the slideshow `trigger`.

## Template & effort

Copy **`transform`** (`[fx]`, video-in). 🟡 — the grid model, wave-phase table,
and per-tile squash/affine are bounded, well-specified drawing work; no sim
integration and no cross-block state.

## Playground demo

An `image` card (dummy bundled photo) → `mosaic-tileflip` → `output`, with a
`beat` signal wired to `flip` and `energy` → `scale`. `[fx]` cards need an
upstream producer in the demo — bundle the dummy asset per the Playground
invariant.

## Variants / open questions

- `back_face`: show a solid colour / mirrored region on the "back" of a flip past
  90° (true split-flap look) vs. always the front region.
- `hold`: freeze the grid flat (all tiles unflipped) between waves for a cleaner
  read, or keep a constant idle shimmer.
- Non-square grids fitted to the frame aspect (letterbox the outer cells).
- `shuffle` motion needs a pairing rule — swap with the neighbour toward the wave
  direction, deterministic from seed, so it stays streaming-consistent.
