# 14 — Pulse rings   `[gen]` · effort 🟢 · Geometric / retro-viz

## Concept

Radar / sonar: on each beat a thin ring is emitted from a centre point and
expands outward, thinning and fading as it grows, so the frame pulses in time
with the music. A crisp, minimal rhythmic layer — the visual equivalent of a
metronome. Reads as a single clean ring blooming on each downbeat at rest and a
storm of overlapping concentric shockwaves when pushed.

**Elegant↔energetic range:** slow `speed` + one emit per bar + thin rings + long
`fade` = a calm sonar sweep; fast `speed` + emit on every onset + thick rings +
short `fade` = a dense rippling ring storm that fills the frame.

## Signal map

| Signal | Natural target |
|---|---|
| `onset` / `beat` (drums) | `emit` — a rising edge emits a new ring |
| `energy` | `thickness` — louder hits throw fatter rings |
| `brightness` | `hue` shift |

## Ports

| key | label | range | default | effect |
|---|---|---|---|---|
| `emit` | emit | 0..1 | 0.0 | rising past 0.5 emits a ring this frame (edge-triggered) |
| `speed` | speed | 0.1..4 | 1.0 | outward expansion rate (radius per second) |
| `thickness` | thickness | 0.5..12 px | 3 | ring line width |
| `fade` | fade | 0..1 | 0.5 | how far/long a ring travels before vanishing |
| `hue` | hue | 0..1 | 0.4 | ring colour |
| `opacity` | opacity | 0..1 | 1.0 | layer alpha |

## Static data

- `origin`: `"center"` / `"random"` / `"bottom"` — where rings are emitted from
  (`"random"` scatters each ring's centre from `seed + emit_index`).
- `shape`: `"ring"` / `"polygon"` / `"bar"` — a circle, an n-gon, or a horizontal
  expanding bar (for a spectrum-sweep feel).
- `seed`: int.

## Backend algorithm

Stateless — a ring is a pure function of its `emit_time` and the current `t =
frame_index / fps`, so it copies `backdrop` (whole-clip + block handler, no
`FluidClip`). Same "detect events up front, then render each event's decayed
contribution" trick as `02-lightning`.

1. **Detect emits ahead of the loop**: from the full-segment `emit` array
   (available in the block handler before slicing), find rising edges past 0.5 →
   a list of `(emit_frame, rng_seed)`. That's the whole "when" story; no
   per-frame state.
2. **Per frame `i`** (`t = i / fps`): for every emit with `emit_frame ≤ i`,
   compute the ring radius `r = speed · (t − emit_frame/fps)`. Drop rings whose
   `r` has grown past the `fade` cutoff (`r > fade·r_max`) — they've expired.
3. **Draw** each live ring with PIL: an annulus / n-gon outline / bar at radius
   `r`, line width `thickness`, centre from `origin` (+ `rng_seed` when
   `"random"`). Alpha decays with age: `α = (1 − r / (fade·r_max))` so rings
   dim as they expand.
4. Colour from `hue`; combine ring coverage with `opacity`. Return
   `(nframes, h, w, 4)` uint8.

Because rings are found from the full array and each ring's radius/alpha is a
pure function of `t − emit_time`, block `[a,b]` renders identically whether or
not earlier blocks ran — no `FluidClip` needed. Cost is (live rings) × one PIL
draw per frame; live rings are bounded by `fade` and emit rate.

## Frontend card

Copy `BackdropNode.tsx` + an `origin` `<select>` and a `shape` `<select>`. The
`emit` port is a trigger-style knob (like the slideshow `trigger` / lightning
`strike`); document that in `paramHelp`. Full-frame, no BoxPad.

## Template & effort

Copy **`backdrop`**. 🟢 — a handful of PIL circle draws over a closed-form radius;
no field, no state, no asset.

## Playground demo

`pulse-rings` → `output`, `beat` (drums) → `emit`, `energy` → `thickness`. No
asset needed.

## Variants / open questions

- `filled` mode: fill each ring as a soft disc for a shockwave-blast look.
- Multiple emit origins (a grid of radar dishes) — a static `origins` count.
- Pair over `12-plasma` or `06-clouds-nebula` for a radar-over-terrain overlay.
