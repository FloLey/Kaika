# 18 — Boids (murmuration)   `[gen]` · effort 🔴 · Organic growth

## Concept

Hundreds of particles flock — each steering by the three classic rules
(separation, alignment, cohesion) while also drifting along a slowly-evolving
noise flow-field — and leave soft motion-trails behind them. It reads as a
murmuration of starlings at dusk: a single wheeling organism made of many
points.

**Elegant↔energetic range:** a small slow flock with high `cohesion` and long
`trail` = a calm cloud wheeling gently across the frame; high `speed` +
`turbulence` with a `beat`-driven scatter = a turbulent swarm that bursts apart
on the hit and regroups.

## Signal map

| Signal | Natural target |
|---|---|
| `energy` | `speed` — the flock flies faster with loudness |
| `flux` | `turbulence` — busier music churns the flow-field |
| `beat` | scatter impulse (a startle that briefly repels the flock) |
| `harmonic` | `cohesion` — tonal passages pull the flock tight |

## Ports

| key | label | range | default | effect |
|---|---|---|---|---|
| `count` | count | 50..800 | 300 | number of boids (int) |
| `speed` | speed | 0.2..3 | 1.0 | flight speed / integration rate |
| `cohesion` | cohesion | 0..1 | 0.5 | pull toward neighbours' centre |
| `separation` | separation | 0..1 | 0.5 | push off close neighbours |
| `turbulence` | turbulence | 0..1 | 0.4 | flow-field strength + a beat scatter kick |
| `trail` | trail | 0..1 | 0.6 | how slowly the motion-trail buffer fades |
| `hue` | hue | 0..1 | 0.6 | palette rotation |
| `opacity` | opacity | 0..1 | 1.0 | layer alpha |

## Static data

- `seed`: int — initial positions/velocities and the flow-field noise.
- `render`: `"dots"` / `"streaks"` / `"triangles"` — how each boid is drawn.
- `palette`: colour ramp (speed or heading maps to hue).

## Backend algorithm — **stateful** (copies `backdrop` I/O + `FluidClip` streaming)

Both the particle array *and* the fading trail buffer depend on their previous
state, so blocks must run **sequentially** and carry them, exactly like
`FluidClip.advance(a, b)`.

1. **Setup** (`_boids_block`): allocate the particle arrays `pos`, `vel`
   (shape `(count, 2)`, seeded from `seed`) and a float trail buffer at output
   size. Params via `dag._fx_params(node)`. `count` is capped for cost. State
   lives in the block handler's closure.
2. **Integrate** per frame: compute neighbour sums (vectorised on a coarse grid,
   or `scipy.spatial.cKDTree` for the near neighbours) → separation / alignment /
   cohesion accelerations; add a curl-noise flow-field advection scaled by
   `turbulence`; on `beat` frames add an outward scatter impulse. Update
   `vel` (clamped to `speed`) and `pos` (wrap at the edges).
3. **Render + trail**: fade the trail buffer by `trail` (`buf *= trail`), then
   draw each boid additively per `render` (dots / velocity-aligned streaks /
   heading triangles), coloured through the palette (`hue`). Alpha follows the
   trail buffer. `opacity` scales it. Return `(nframes, h, w, 4)`.

**Streaming contract**: `produce(a, b)` advances the flock and the trail buffer
from where the last block left off (state in the closure). Blocks arrive
front-to-back and contiguous (the render engine guarantees it, same as fluid),
so the streamed result equals a whole-clip render. The whole-clip handler runs
the same loop over `[0, nframes]`. Register resources via
`dag._closers.append(...)`; it's a **good candidate for the raw-frame cache**.

## Frontend card

Copy `BackdropNode.tsx` + `render` and `palette` `<select>`s. `count` is an int
slider. Previews as a standalone generator.

## Template & effort

Copy **`backdrop`** for the I/O + **`FluidClip`** for the stateful streaming.
🔴 — the neighbour search is the cost; keep it vectorised and cap `count`.

## Playground demo

`boids` → `output`, `energy` → `speed`, `flux` → `turbulence`,
`beat` → (scatter via `turbulence`).

## Variants / open questions

- A `predator` mode: one boid the flock flees (spawned on `onset`) — dramatic
  scatter without touching the beat wiring.
- `perch`: attract the flock toward a wired point / the frame centre on `bar`.
- 3-D projected boids (depth-sorted, size-by-z) for a fuller murmuration — more
  cost, more depth.
- Tune the neighbour grid cell size to `separation` radius so cost stays flat as
  the flock spreads.
