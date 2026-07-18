# 10 — Warp tunnel   `[gen]` · effort 🟡 · Geometric / retro-viz

## Concept

An endless flight down the throat of a tunnel: a texture wrapped around a
cylinder and mapped through polar coordinates so it rushes toward the camera and
peels past the edges of the frame, receding to a vanishing point at the centre.
By default the texture is procedural — concentric rings or lengthwise stripes —
so no asset is needed. It reads as a calm hypnotic drift through soft glowing
rings at rest and a nauseous hyperspace strobe rush when pushed.

**Elegant↔energetic range:** low `speed` + wide soft `ring_freq` + zero `twist` =
a slow meditative float down a cathedral of light; high `speed` + tight rings +
strong `twist` + high `contrast` = a strobing warp-drive lurch that jerks on the
beat.

## Signal map

| Signal | Natural target |
|---|---|
| `energy` (drums/bass) | `speed` — the flight rushes faster with loudness |
| `beat` | `speed` lurches — a short kick forward each beat |
| `brightness` | `hue` shift (cool tunnel ↔ hot tunnel) |
| `flux` | `twist` — busier music spins the tunnel walls harder |

## Ports

| key | label | range | default | effect |
|---|---|---|---|---|
| `speed` | speed | 0..4 | 1.0 | depth advanced per second (flight velocity) |
| `twist` | twist | 0..1 | 0.2 | radius-dependent rotation of the tunnel wall |
| `fov` | field of view | 0.2..2 | 1.0 | how fast the walls recede (fisheye ↔ flat) |
| `ring_freq` | ring frequency | 1..40 | 12 | texture repeats along the depth axis |
| `hue` | hue | 0..1 | 0.6 | palette rotation |
| `contrast` | contrast | 0..1 | 0.5 | texture hardness (soft gradient ↔ hard bands) |
| `opacity` | opacity | 0..1 | 1.0 | layer alpha |

## Static data

- `pattern`: `"stripes"` / `"rings"` / `"checker"` / `"grid"` — the procedural
  wall texture sampled in `(θ, depth)` space.
- `palette`: named ramp (`"neon"`, `"chrome"`, `"ember"`, `"mono"`); `hue`
  rotates within it.
- `seed`: int, so two tunnels differ in phase.

## Backend algorithm

Fully stateless — every pixel is a closed-form function of `t = frame_index /
fps`, so it copies `backdrop` (whole-clip + block handler, no `FluidClip`).

1. **Precompute polar coords once** for the frame grid `(Y, X)` centred on the
   middle: angle `θ = arctan2(Y, X)` and radius `r = hypot(Y, X)` (both
   `(H, W)` arrays). This is the projection of a cylinder wall — reuse it every
   frame.
2. **Depth axis.** Map radius to depth so equal steps in depth look infinite:
   `depth = fov / (r + ε)` (near the centre `r→0` → depth →∞, the vanishing
   point). Flight = subtract `speed·t`, so `u = ring_freq · depth − speed·t`.
3. **Angular axis.** `twist` rotates the wall by a radius-dependent amount:
   `v = θ + twist · depth`. So the tunnel appears to spiral as it recedes.
4. **Sample the procedural texture** at `(u, v)` — e.g. stripes = `sin(2π·u)`,
   rings = `sin(2π·u)` on depth only, checker = `sign(sin u)·sign(sin(θ·k))`,
   grid = both. `contrast` pushes the scalar through a smoothstep toward hard
   bands. Result is a `(H, W)` scalar in 0..1.
5. **Colour** through the palette (`hue` rotates it); darken with depth so the
   far end falls to black (`brightness ∝ r`, a natural vignette). Alpha =
   `opacity`. Return `(nframes, h, w, 4)` uint8.

All numpy; a frame is a couple of `sin`/`arctan2` over `(H, W)`. `arctan2`/
`hypot` are computed once and cached, not per frame.

## Frontend card

Copy `BackdropNode.tsx` + a `pattern` `<select>` and a `palette` `<select>`
(like the video card's `fit`). Full-frame, no BoxPad.

## Template & effort

Copy **`backdrop`**. 🟡 not 🟢 only for the polar remap + texture design; there
is no state and no asset, so streaming is trivial (`frame_offset` → `t`).

## Playground demo

`warp-tunnel` → `output`, `energy` (drums) → `speed`, `flux` → `twist`. No asset
needed.

## Variants / open questions

- Let `pattern: "asset"` sample a wired image/video instead of the procedural
  texture — but that makes it an `[fx]` card; keep the procedural default here.
- `wobble`: sway the tunnel centre on a slow LFO so the camera banks.
- A `glow` port (blur bloom on the bright bands) would push cost up slightly.
- Pair under `11-starfield` in a stack combine for a full cockpit-warp look.
