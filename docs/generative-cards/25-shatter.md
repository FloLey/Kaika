# 25 — Shatter   `[fx]` · effort 🟡 · Video→video FX

## Concept

The incoming frame cracks into a mosaic of shards — a precomputed Voronoi (or
triangulated) fracture — and on the beat the shards **jitter, spin, and explode
outward**, then settle back into place, like glass breaking in reverse. Each
shard carries its own masked region of the input, so mid-explosion you see the
picture fragmented and spread across the frame before it snaps home. Because it's
an `[fx]` card it shatters *whatever is wired in* — a photo, a clip, a fluid.

The explosion is an analytic impulse-plus-decay driven by onsets (like
`02-lightning`'s afterglow), so the shards spring apart on the hit and ease back
without any integrated physics — the whole effect stays a deterministic function
of the frame index.

**Elegant↔energetic range:** few large shards with a small `spread` and gentle
`spin` = the surface trembling as if under stress, barely coming apart; hundreds
of tiny shards with a big `spread`, heavy `spin`, and `gravity` pulling them down
= a full glass-smash blasting apart on the drop and raining out of frame.

## Signal map

| Signal | Natural target |
|---|---|
| `onset` (drums) | `explode` — a rising edge fires an outward impulse |
| `energy` | `spread` — louder = shards fly farther |
| `flux` | `spin` — busier spectrum tumbles the shards faster |
| `beat` | `explode` pulse (alt. wiring — a rhythmic breathe-apart) |

## Ports

| key | label | range | default | effect |
|---|---|---|---|---|
| `explode` | explode | 0..1 | 0.0 | rising past 0.5 fires an outward impulse (edge-triggered) |
| `spread` | spread | 0..1 | 0.5 | max outward displacement (fraction of frame) |
| `spin` | spin | 0..1 | 0.3 | per-shard rotation amount during flight |
| `gravity` | gravity | -1..1 | 0.0 | downward (−) / upward (+) drift added to flight |
| `gap` | gap | 0..0.05 | 0.005 | dark seam width between shards |
| `radius` | soft edge | 0..0.1 | 0.0 | shard mask feather |
| `opacity` | opacity | 0..1 | 1.0 | layer alpha |

## Static data

- `pieces`: int (8..400) — number of Voronoi seed points (shard count).
- `fracture`: `"voronoi"` (organic cells), `"triangles"` (Delaunay shards),
  `"grid-cracks"` (a jittered rectangular break).
- `origin`: `"center"` / `"random"` / `"point"` — where shards explode away from
  (a fixed `(x,y)` for `"point"`).
- `seed`: int (seed-point layout + per-shard flight vectors — derive from seed
  only, never wall-clock, so a render is reproducible and streaming-consistent).

## Backend algorithm

`[fx]` copying `transform`; the shard map is precomputed **once** and each frame's
shard poses are analytic, so there is **no per-block state**.

1. `src = _video_source(dag.graph, node["id"], "video")`; if `None` raise
   `ValueError`. Whole-clip `frames = dag.video(src)`; block
   `producer = dag._block_producer(src)`, `params = dag._fx_params(node)`.
   A `_shatter_static(data)` reads pieces/fracture/origin/seed.
2. **Precompute the shard map once** (setup, not per-frame): scatter `pieces`
   seed points from `seed`, then assign every pixel to its nearest seed with a
   `scipy.spatial.cKDTree` query (or a vectorised distance `argmin`) → a per-shard
   boolean mask + centroid. Each shard also gets a flight direction (outward from
   `origin`) and a spin sign from `seed`.
3. **Explosion offset per frame.** From the full-segment `explode` array, each
   rising edge starts an impulse; a shard's displacement at frame `i` is
   `spread · dir · impulse_envelope(i)` where the envelope is an analytic
   attack-then-exponential-decay (the `02-lightning` afterglow trick), plus
   `gravity` accumulated over the flight fraction. Rotation is `spin · envelope`.
4. **Composite frame `i`**: for each shard, take `frames[i]` masked by the shard
   mask, apply its per-shard affine (translate by the offset, rotate about its
   centroid — PIL/`scipy.ndimage.affine_transform`), and alpha-over the
   shards back-to-front. Apply `gap` seams and `radius` mask feather.
5. Output RGBA — carry the input's alpha, or opaque where the input is
   dye-on-black `(T,H,W,3)`. `opacity` scales alpha.

Because the mask/centroid map is built once and reused for every frame, the
per-frame cost is `pieces` masked affines — bounded and vectorisable.

## Frontend card

Copy `TransformNode.tsx` (has a video input + a mode `<select>`). Add a `pieces`
number input and the `fracture` + `origin` selects. `explode` is a trigger port —
document in `paramHelp` like the slideshow `trigger`.

## Template & effort

Copy **`transform`** (`[fx]`, video-in). 🟡 — the Voronoi shard-map precompute
(scipy) plus per-shard masked affines is real but bounded work; the explosion is
analytic (no physics integration, no cross-block state).

## Playground demo

An `image` card (dummy bundled photo) → `shatter` → `output`, with `onset`
(drums) wired to `explode` and `energy` → `spread`. `[fx]` cards need an upstream
producer in the demo — bundle the dummy asset per the Playground invariant.

## Variants / open questions

- `reassemble`: bias the envelope so shards *converge* from spread-out into place
  over a bar (glass un-breaking) vs. the default explode-and-settle.
- Depth sort by shard distance for a faux-3D tumble (nearer shards drawn larger).
- `crack_lines`: draw the fracture seams as bright glints on the beat even when
  the shards haven't moved (tension without explosion).
- Re-fracture on a trigger (new seed layout) — needs care to stay
  streaming-consistent (derive the new seed from the trigger frame index).
