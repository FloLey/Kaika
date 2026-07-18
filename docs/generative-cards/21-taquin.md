# 21 — Taquin (sliding puzzle)   `[fx]` · effort 🟡 · Video→video FX

## Concept

The incoming frames are diced into an R×C grid with one missing tile (the hole).
The picture is scrambled, then **auto-solved** over the segment — and every beat
nudges one tile sliding (glide-eased) into the hole. Because it's an `[fx]` card,
it puzzles *whatever is wired in*: a photo, a video clip, even a live fluid. The
underlying video keeps playing while the tiles rearrange, exactly like the
standalone Taquin widget, but here the moves are driven by the music instead of a
mouse.

Ported from the `FloLey-public-website` Taquin
(`src/components/widgets/Taquin/`): reuse its **solvable-shuffle** (legal moves,
never a random permutation — parity makes half insolvable), its **glide**
easing, and its **search-based solver** (`solver.ts`) logic — translated from
TS/canvas to numpy/PIL and made time-driven rather than input-driven.

**Elegant↔energetic range:** small grid (3×3) + slow one-move-per-bar + wide
gaps = a calm, contemplative reassembly; large grid (6×6) + a slide on every
onset + tight gaps = a frantic shuffling mosaic.

## Signal map

| Signal | Natural target |
|---|---|
| `beat` / `onset` | `slide` — a rising edge performs the next move |
| `energy` | `glide` speed feel (snappier on louder passages) |
| `bar` | phase for scramble→solve cycling (optional) |

## Ports

| key | label | range | default | effect |
|---|---|---|---|---|
| `slide` | slide | 0..1 | 0.0 | rising past 0.5 advances one move (edge-triggered) |
| `glide` | glide | 0..1 | 0.5 | tile glide duration (0 = snap, 1 = slow slide) |
| `gap` | gap | 0..0.1 | 0.01 | spacing between tiles (fraction of tile) |
| `radius` | corner | 0..0.3 | 0.05 | tile corner rounding |
| `opacity` | opacity | 0..1 | 1.0 | layer alpha |

## Static data

- `rows`, `cols`: int (2..8 each).
- `mode`: `"scramble-solve"` (scramble at seg start, solve over the segment),
  `"shuffle"` (endless legal moves), `"solve-loop"` (solve then reshuffle).
- `hole`: which cell is missing (`"br"` default) and whether it's filled on
  completion (like the widget's win state).
- `seed`: int (shuffle RNG — derive from seed only, never wall-clock, so a render
  is reproducible and streaming-consistent).

## Backend algorithm

`[fx]` copying `transform`; the move schedule is precomputed so blocks are
consistent.

1. `src = _video_source(dag.graph, node["id"], "video")`; whole-clip
   `frames = dag.video(src)`, block `producer = dag._block_producer(src)`.
   A `_taquin_static(data)` reads rows/cols/mode/seed.
2. **Precompute the move schedule** from the full-segment `slide` array (rising
   edges → move indices) + the solvable shuffle (port the `shuffle` loop:
   `K = N·20` legal moves from `(seed)`), then the solver queue
   (port `solvePuzzle`: solve top rows by BFS, last two rows by A*). This yields,
   for each frame `i`, the board state + any in-flight glide `(home, fromPos,
   toPos, start)`. No per-block state — frame `i` maps to a deterministic board.
3. **Render frame `i`**: for each cell, `drawImage`-equivalent = copy the source
   region `(home%C, home//C)` of `frames[i]` into the destination cell (numpy
   slice + PIL rounded-rect clip for `radius`/`gap`). The moving tile is offset by
   `(1−ease(t))` toward its old cell (port the glide math). The hole cell is
   transparent (or filled on completion).
4. Output RGBA (carry the input's alpha, or opaque where the input is dye-on-
   black). `opacity` scales alpha.

The port from `useTaquin.ts`: `neighbors`, `adjacent`, `isSolved`, `applyMove`,
`shuffle`, and the `draw` tile-copy loop map almost 1:1 to numpy; `solver.ts`'s
BFS/A* is pure and translates directly.

## Frontend card

Copy `TransformNode.tsx` (has a video input + a mode `<select>`). Add
`rows`/`cols` number inputs and the `mode` select. `slide` is a trigger port —
document in `paramHelp` like the slideshow `trigger`.

## Template & effort

Copy **`transform`** (`[fx]`, video-in). 🟡 — the board model + solver port is
real work but bounded and well-specified by the reference implementation; no sim
integration.

## Playground demo

An `image` card (dummy bundled photo) → `taquin` → `output`, with a `beat` signal
wired to `slide`. `[fx]` cards need an upstream producer in the demo — bundle the
dummy asset per the Playground invariant.

## Variants / open questions

- `solved_hold`: freeze on the solved image for N frames before reshuffling.
- Tile-content option: instead of the image regions, fill tiles with a wired
  *second* video (would need a 2nd video input — out of scope for v1).
- Numbers overlay (debug/kitsch) toggle.
- Non-square grids fitted to the frame aspect (the widget's v1 punted on this).
