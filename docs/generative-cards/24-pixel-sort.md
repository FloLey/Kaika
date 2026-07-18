# 24 — Pixel sort (databend)   `[fx]` · effort 🟡 · Video→video FX

## Concept

Classic databending / glitch art: within each row (or column), find the spans
where the picture is bright enough and **sort the pixels along them**, producing
the signature smeared-streak look where colour bleeds into long combed bands.
Layer on an RGB-channel split (chromatic aberration) and block-displacement
glitches that burst on transients, and a still photo becomes a corrupted-signal
artefact that tears and reassembles with the music. Because it's an `[fx]` card
it bends *whatever is wired in* — a photo, a clip, a fluid.

The sort is the calm backbone; the block-glitch and RGB-split are the punctuation
— the effect's intensity scales continuously from a barely-there shimmer to
full-frame screen-tearing chaos.

**Elegant↔energetic range:** a short `sort_len` with a high `threshold` (only the
brightest highlights smear) and no glitch = an occasional glassy shimmer along
the light edges; a long `sort_len` with a low threshold, heavy `rgb_split`, and
`block_glitch` firing every onset = the whole frame combing, tearing, and
displacing on every hit.

## Signal map

| Signal | Natural target |
|---|---|
| `onset` (drums) | `block_glitch` — a rising edge bursts a block displacement |
| `energy` | `sort_len` — louder = longer sort spans |
| `flux` | `rgb_split` — busier spectrum splits the channels wider |
| `brightness` | `threshold` — spectral centroid raises/lowers the sort cutoff |

## Ports

| key | label | range | default | effect |
|---|---|---|---|---|
| `sort_len` | sort | 0..1 | 0.3 | max span length that gets sorted (fraction of row) |
| `threshold` | threshold | 0..1 | 0.5 | luma cutoff — spans brighter than this are sorted |
| `direction_bias` | direction | 0..1 | 0.5 | sort order (0 = ascending, 1 = descending) |
| `rgb_split` | rgb split | 0..0.1 | 0.0 | R/B channel horizontal shift (fraction of width) |
| `block_glitch` | glitch | 0..1 | 0.0 | rising past 0.5 displaces random blocks (edge-triggered) |
| `opacity` | opacity | 0..1 | 1.0 | layer alpha |

## Static data

- `axis`: `"row"` (sort horizontally — classic) or `"col"` (vertical streaks).
- `sort_key`: `"luma"` / `"hue"` / `"saturation"` — the value each span is
  argsorted by (luma is the databend default).
- `mode`: `"threshold-span"` (sort only spans above `threshold`, the signature
  look) or `"full"` (sort every row edge-to-edge — a heavier smear).
- `seed`: int (block-glitch positions/sizes — derive from seed only, never
  wall-clock, so a render is reproducible and streaming-consistent).

## Backend algorithm

`[fx]` copying `transform`; every frame is a pure function of its input plus the
per-frame params, so there is **no per-block state**.

1. `src = _video_source(dag.graph, node["id"], "video")`; if `None` raise
   `ValueError`. Whole-clip `frames = dag.video(src)`; block
   `producer = dag._block_producer(src)`, `params = dag._fx_params(node)`.
   A `_pixelsort_static(data)` reads axis/sort_key/mode/seed.
2. **Sort pass** per frame (vectorised, `axis="col"` transposes first): compute a
   luma map, build a boolean mask `luma > threshold`, then for each contiguous
   `True` span (capped at `sort_len·W`) `argsort` its pixels by the `sort_key`
   channel and reorder — `direction_bias` picks ascending/descending. The
   per-row `argsort` is the cost driver (O(H·W·log W)); do it with a single
   `np.argsort` over the masked segment indices per row rather than Python loops.
3. **RGB split**: `np.roll` the R channel `+rgb_split·W` and the B channel
   `−rgb_split·W` (clamp or wrap edges) for chromatic aberration.
4. **Block glitch**: on a `block_glitch` rising edge, pick `seed`-driven random
   rectangular blocks and displace each by a random offset (copy-shift within the
   frame) — an analytic burst, no state carried, so streamed == whole-clip.
5. Output RGBA — carry the input's alpha, or opaque where the input is
   dye-on-black `(T,H,W,3)`. `opacity` scales alpha.

## Frontend card

Copy `TransformNode.tsx` (has a video input + a mode `<select>`). Add the `axis`,
`sort_key`, and `mode` selects. `block_glitch` is a trigger port — document in
`paramHelp` like the slideshow `trigger`.

## Template & effort

Copy **`transform`** (`[fx]`, video-in). 🟡 — the sort is the whole cost; a naive
per-row Python loop is too slow, so budget for a vectorised span-argsort (mask →
segment offsets → single `argsort`). No sim, no cross-block state.

## Playground demo

An `image` card (dummy bundled photo) → `pixel-sort` → `output`, with `energy`
wired to `sort_len` and `onset` → `block_glitch`. `[fx]` cards need an upstream
producer in the demo — bundle the dummy asset per the Playground invariant.

## Variants / open questions

- `angle`: sort along an arbitrary angle (rotate → sort rows → rotate back)
  rather than only row/col.
- `edge_key`: seed spans from a Sobel edge map instead of a luma threshold — sorts
  *between* contours, a different databend flavour.
- Temporal smear: carry a fraction of the previous sorted frame for motion trails
  — but that makes it stateful (🔴), out of scope for v1's stateless design.
- Document the per-frame cost of `full` mode vs `threshold-span` (full is the
  expensive path at large resolutions).
