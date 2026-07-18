# 11 — Starfield   `[gen]` · effort 🟢 · Geometric / retro-viz

## Concept

The classic warp starfield: points stream radially outward from a central
vanishing point, each leaving a speed-scaled streak so the frame reads as flight
through space. At rest it's a sparse, slow drift of faint stars; pushed, it's a
dense hyperspace smear of long streaks bursting on the beat. The archetypal
"we're going to lightspeed" screensaver, cheap and instantly legible.

**Elegant↔energetic range:** low `speed` + low `density` + short `streak` = a
calm sprinkle of drifting stars; high `speed` + high `density` + long streaks +
`warp` near 1 = a blinding hyperspace tunnel that lurches forward on every hit.

## Signal map

| Signal | Natural target |
|---|---|
| `energy` (drums/bass) | `speed` — warp velocity follows loudness |
| `onset` | `warp` burst — a transient kicks the whole field forward |
| `flux` | `density` — busier music adds more stars |
| `brightness` | `hue` shift (cool white ↔ warm) |

## Ports

| key | label | range | default | effect |
|---|---|---|---|---|
| `speed` | speed | 0..4 | 1.0 | outward velocity of every star |
| `density` | density | 0..1 | 0.4 | fraction of the star pool drawn |
| `streak` | streak | 0..1 | 0.3 | trail length as a multiple of per-frame travel |
| `warp` | warp | 0..1 | 0.0 | extra forward boost (burst on hits) |
| `hue` | hue | 0..1 | 0.6 | star tint |
| `twinkle` | twinkle | 0..1 | 0.3 | per-star brightness flicker |
| `opacity` | opacity | 0..1 | 1.0 | layer alpha |

## Static data

- `seed`: int — seeds the fixed star pool (angles + phase offsets).
- `depth_fade`: bool — dim stars near the centre (far away) and brighten them at
  the rim (close), for a stronger sense of depth.

## Backend algorithm

Fully stateless — each star's position is a closed-form function of `t =
frame_index / fps` and its own `(seed, index)`, so it copies `backdrop`
(whole-clip + block handler, no `FluidClip`).

1. **Fixed star pool** built once from `seed`: N stars, each with a random
   angle `α_i`, a random phase `φ_i ∈ [0,1)`, and a random twinkle rate. Reuse
   the same `(seed, i)` hashing the `noise` modulator uses so streaming is
   deterministic — no per-frame RNG draws.
2. **Radius from time.** A star's normalized depth grows and wraps:
   `p = frac(φ_i + (speed + warp)·t)`. Push `p` through an ease
   (e.g. `p²`) so stars accelerate as they near the rim — the signature warp
   feel. Screen radius `r = p · r_max`; position `= centre + r·(cos α_i,
   sin α_i)`.
3. **Draw** as a streak: a PIL `ImageDraw.line` from the star's position one
   step back along its ray (length `∝ streak · speed · r`) to its current
   position, width growing with `r`. Only draw stars with `p < density`-derived
   cutoff — cheaper fields at low `density`.
4. **Brightness**: fade with depth if `depth_fade` (α `∝ r`), multiply by a
   `twinkle` term `= 1 + twinkle·sin(2π·rate_i·t + φ_i)`. Colour from `hue`.
   Alpha = `opacity`. Return `(nframes, h, w, 4)` uint8.

`frac`/wrap makes it seamless and streamable: block `[a,b]` only needs `t`, no
carried state. A few thousand short PIL lines per frame is cheap; batch into one
`ImageDraw` pass.

## Frontend card

Copy `BackdropNode.tsx` + a `depth_fade` checkbox. Full-frame, no BoxPad.

## Template & effort

Copy **`backdrop`**. 🟢 — the star pool is a fixed array and every position is a
closed form; the only "geometry" is batched line drawing.

## Playground demo

`starfield` → `output`, `energy` (drums) → `speed`, `onset` → `warp`. No asset
needed.

## Variants / open questions

- `origin` port to move the vanishing point off-centre (banking flight).
- A `colour_by_depth` mode: tint near stars hot and far stars cold for a nebula
  feel.
- Round "points" mode (no streaks) for a gentle drifting-dust look — could be a
  `streak = 0` preset rather than a toggle.
