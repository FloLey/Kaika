# 03 — Fire   `[gen]` · effort 🟢 · Natural / elemental

## Concept

A wall of flame licking up from the bottom edge: hot white/yellow at the base
fading through orange to smoky red at the tips, flickering and curling as it
rises. Calm campfire at low energy, roaring inferno filling the frame at high
energy. A classic warm bed layer for a stack.

**Elegant↔energetic range:** low `height` + low `turbulence` = gentle candle-like
flicker; high `height` + high `turbulence` + wide `spread` = a full-frame blaze.

## Signal map

| Signal | Natural target |
|---|---|
| `energy` (bass/drums) | `height` — the flame leaps with loudness |
| `flux` | `turbulence` — busier music = more chaotic flicker |
| `brightness` | `hue` shift (deep red ↔ blue-hot) |
| `onset` | brief `height` spikes (flare-ups on hits) |

## Ports

| key | label | range | default | effect |
|---|---|---|---|---|
| `height` | height | 0..1 | 0.5 | how far up the frame flames reach |
| `turbulence` | turbulence | 0..1 | 0.4 | noise distortion of the flame front |
| `spread` | spread | 0..1 | 0.6 | horizontal width of the flame base |
| `speed` | speed | 0.1..4 | 1.0 | upward advection / flicker rate |
| `hue` | hue | 0..1 | 0.05 | base colour temperature (red→blue-hot) |
| `opacity` | opacity | 0..1 | 1.0 | layer alpha |

## Static data

- `palette`: `"flame"` (black-body) / `"green-fire"` / `"blue-fire"` /
  `"ghost"` — the temperature ramp.
- `seed`: int.

## Backend algorithm

Fully stateless field → copies `backdrop`.

1. A "heat" field `H(x, y, t)`: a base gradient hot at the bottom, multiplied by
   an animated fbm noise scrolling **upward** at `speed` (sample noise at
   `(x·s, y·s − speed·t)`), warped horizontally by `turbulence`. `height` scales
   the vertical falloff; `spread` shapes a horizontal envelope so the flame
   tapers at the sides.
2. Map `H` through the black-body palette (`hue` shifts it): high→white/yellow,
   mid→orange, low→transparent. Alpha = `smoothstep(H)` so the flame edges are
   soft and the top fades out — the layer is mostly transparent above the
   flame.
3. `opacity` scales alpha. Return `(nframes, h, w, 4)`.

Reuse the same value-noise helper as the `noise` modulator (or a small tileable
one). All numpy; cheap.

## Frontend card

Copy `BackdropNode.tsx` + a `palette` `<select>`.

## Template & effort

Copy **`backdrop`**. 🟢 — pure vectorised field, no geometry, no state.

## Playground demo

`fire` → `output`, `energy` (bass) → `height`, `flux` → `turbulence`.

## Variants / open questions

- Add `embers`: sparse rising spark particles (deterministic from seed+frame) —
  would nudge it toward 🟡.
- A `direction` port to make it burn sideways / downward (torch vs pit).
- Smoke variant: same engine, desaturated palette, slower `speed`, taller
  `height` — could be a preset rather than a separate card.
