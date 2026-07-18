# 26 — Voronoi mosaic   `[either]` · effort 🟡 · Video→video FX

## Concept

A living stained-glass / low-poly mosaic: Voronoi cells tile the frame, and each
cell is flat-filled with a single colour — in `[fx]` mode the **mean colour of
the input** under that cell (so a photo dissolves into shifting facets), or in
`[gen]` mode a **palette colour** (so it runs standalone with no input wired at
all — hence `[either]`). The cells drift, pulse, and scatter on the beat, and
bright cell edges glow, so the whole surface reads like animated stained glass or
a shattering-and-reforming low-poly render.

Because it degrades to a self-contained generator when nothing is wired, this is
the one FX card that doubles as a source — the `_video_source` may return `None`,
and the card falls back to palette fills the way `stylize` handles a missing
input.

**Elegant↔energetic range:** few large cells (`cells` low) drifting slowly with a
soft edge glow = a calm, slowly-morphing cathedral window; hundreds of tiny cells
scattering hard on every beat and snapping back = a glittering low-poly storm
shattering and reforming to the rhythm.

## Signal map

| Signal | Natural target |
|---|---|
| `beat` | `scatter` — a rising edge kicks the seeds apart, then they `relax` |
| `energy` | `cells` feel (denser mosaic on louder passages, via port range) |
| `flux` | `edge` — busier spectrum brightens the cell-edge glow |
| `chroma` | `hue` — dominant pitch class rotates the palette (gen mode) |

## Ports

| key | label | range | default | effect |
|---|---|---|---|---|
| `cells` | cells | 16..600 | 120 | number of Voronoi seed points (int) |
| `scatter` | scatter | 0..1 | 0.0 | beat-driven jitter of the seeds (fraction of frame) |
| `relax` | relax | 0..1 | 0.5 | how fast scattered seeds settle back to their drift |
| `edge` | edge glow | 0..1 | 0.3 | cell-boundary glow strength / width |
| `drift` | drift | 0..1 | 0.2 | continuous deterministic seed motion speed |
| `hue` | hue | 0..1 | 0.0 | palette hue rotation (gen mode) / tint (fx mode) |
| `opacity` | opacity | 0..1 | 1.0 | layer alpha |

## Static data

- `mode`: `"fx"` (sample the input — per-cell mean colour) or `"gen"` (palette
  fill, no input needed). When `mode:"fx"` but no input is wired, degrade to
  `"gen"` (see backend).
- `metric`: `"voronoi"` (nearest-seed) or `"weighted"` (power/additively-weighted
  cells for varied sizes).
- `palette`: named ramp for `[gen]` fills (same palette list the other sources
  use).
- `seed`: int (seed-point layout + scatter RNG — derive from seed only, never
  wall-clock, so a render is reproducible and streaming-consistent).

## Backend algorithm

`[fx]`/`[either]` copying `transform`, but tolerant of a missing source; each
frame's seed positions are analytic (drift + beat-scatter envelope), so there is
**no per-block state**.

1. `src = _video_source(dag.graph, node["id"], "video")`. `_video_source` itself
   returns `None` for an unwired input (it never raises — the `transform`/
   `stylize` handlers are the ones that choose to raise on `None`). This card
   instead branches: on `None`, set `bed = None` and force `[gen]` behaviour
   (palette fill) rather than erroring. If present, whole-clip
   `frames = dag.video(src)`; block `producer = dag._block_producer(src)`.
   `params = dag._fx_params(node)`; a `_voronoi_static(data)` reads
   mode/metric/palette/seed.
2. **Seed positions per frame.** Lay out `cells` base points from `seed`; add a
   continuous deterministic drift `drift·f(t, seed)` and, on each `scatter`
   rising edge, a jitter impulse that decays back at rate `relax` (analytic
   envelope — no state). `cells` may vary per frame via its port; snap to an int
   count and reuse a stable prefix of the seed list so the count can grow/shrink
   without popping.
3. **Cell assignment.** Assign every pixel to its nearest seed — `scipy.spatial`
   `cKDTree` query over the pixel grid, or a vectorised distance `argmin` at a
   downscaled resolution then upsample the label map (the label map is the cost;
   note it, and cache the pixel grid).
4. **Fill.** `[fx]`: per-cell mean of `frames[i]` over each label (a
   `scipy.ndimage.mean` / `np.bincount` reduction), painted back into the cell.
   `[gen]`: index the `palette` by cell id, rotated by `hue`. Draw cell edges as a
   glow where the label changes (`edge` sets width/brightness).
5. Output RGBA — carry the input's alpha in `[fx]`, opaque in `[gen]`.
   `opacity` scales alpha.

## Frontend card

Copy `TransformNode.tsx` (has a video input + a mode `<select>`). Add a `cells`
number input and the `mode` / `metric` / `palette` selects. Because it's
`[either]`, the video input is optional — the card still previews (as a generator)
with nothing wired.

## Template & effort

Copy **`transform`** (`[fx]` I/O) but tolerate a `None` source like `stylize`. 🟡
— the Voronoi label map + per-cell mean reduction is the cost; keep it fast with a
downscaled `argmin` label pass. No sim, no cross-block state.

## Playground demo

An `image` card (dummy bundled photo) → `voronoi-mosaic` → `output`, `mode:"fx"`,
with `beat` wired to `scatter`. `[fx]` cards need an upstream producer in the
demo — bundle the dummy asset per the Playground invariant. (A second `gen`-mode
preset with no input would exercise the degrade path.)

## Variants / open questions

- `centroidal`: one Lloyd-relaxation step per frame for evenly-sized cells (more
  even, slightly costlier).
- `edge_only`: draw just the glowing cell wireframe over the input (a facet
  overlay) instead of filled cells.
- Per-cell content beyond mean colour (median, dominant colour) — mean is
  cheapest and reads well; document the trade-off.
- Nail down the `mode:"fx"` + no-input degrade: force `"gen"` and log once, so the
  Playground demo and a bare drop-in both behave predictably.
