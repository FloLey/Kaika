# 09 — Spectrum bars   `[gen]` · effort 🟢 · Sound-native

## Concept

The classic music-visualizer EQ: a row of bars whose heights track the energy of
successive frequency bands, pulsing and glowing on the beat. Laid out linearly
along the bottom, mirrored, or radiating from a centre ring like a bloom. It's
the most conventional and reliable card in the catalog — but still spans a wide
look through its parameters.

**Elegant↔energetic range:** a few wide bars with heavy `smoothing`, soft `glow`
and no caps reads as a calm, minimal meter; many thin bars with `peak_hold`
caps, mirrored layout and hard peaks reads as a hyperactive club visualizer.
Same card.

## Signal map

| Signal | Natural target |
|---|---|
| band `energy` × N | the N bar heights — one band signal per bar (see Variants) |
| `beat` | global pulse — every bar swells on the beat |
| `brightness` | `hue` shift across the spectrum |
| `onset` | `peak_hold` cap kicks — caps jump on transients |

## Ports

| key | label | range | default | effect |
|---|---|---|---|---|
| `bar_count` | bars | 4..64 | 24 | number of bars / bands drawn |
| `spacing` | spacing | 0..1 | 0.2 | gap between bars as a fraction of bar width |
| `smoothing` | smoothing | 0..1 | 0.3 | extra temporal easing added on top of the signal shaping |
| `radius` | radius | 0..1 | 0.4 | inner ring radius (radial layout only) |
| `peak_hold` | peak hold | 0..1 | 0.3 | how long peak caps linger before falling |
| `glow` | glow | 0..1 | 0.4 | additive gaussian bloom around the bars |
| `hue` | hue | 0..1 | 0.55 | base colour; spread across bars by band index |
| `opacity` | opacity | 0..1 | 1.0 | layer alpha |

## Static data

- `layout`: `"linear-bottom"` / `"linear-mirror"` / `"radial"` — bar placement.
- `cap`: bool — draw a floating peak cap above each bar.
- `palette`: named ramp; bars colour by band index, `hue` offsets it.
- `seed`: int.

## Backend algorithm

Stateless field → copies `backdrop` (whole-clip + block, no `FluidClip`); each
frame is a pure function of that frame's wired band values.

1. **Read the bands**: gather the `bar_count` wired band signals for frame `i`
   into a length-`bar_count` height vector (0..1). `smoothing` applies a light
   extra temporal ease (the signals are already attack/release shaped, so this
   is a top-up); `beat` multiplies a global swell.
2. **Draw** into an RGBA scratch with PIL:
   - `linear-bottom` / `linear-mirror`: filled rounded rects across the bottom,
     width from `bar_count`/`spacing`, height from the band value; mirror
     duplicates upward.
   - `radial`: angular wedges radiating from `radius`, one per band around the
     circle.
3. **Peak caps** (if `cap`): a thin mark held at each band's recent max, decaying
   at a rate set by `peak_hold`. Resolve without state the `02-lightning` way —
   the recent max over a fixed lookback window is a pure function of the band
   array slice, so blocks stay independent.
4. **Shade**: colour by band index through `palette`/`hue`; add a
   gaussian-blurred copy (`scipy.ndimage`) for `glow`. Alpha = coverage ×
   `opacity`. Return `(nframes, h, w, 4)` uint8.

All numpy/PIL; cheap.

## Frontend card

Copy `BackdropNode.tsx` + a `layout` `<select>`, a `cap` toggle and a `palette`
`<select>`. The interesting UI question is how the N band ports appear — see
below.

## Template & effort

Copy **`backdrop`**. 🟢 — filled rects/wedges over a band vector, no geometry
recursion and no sim state.

## Playground demo

`spectrum-bars` → `output`, several band `energy` signals wired to the bar
inputs, `beat` for the pulse. `layout: linear-mirror`. No asset needed.

## Variants / open questions

- **Main design decision — how the card receives multiple band signals.** Three
  options, each with a real contract cost:
  1. **One vector input**: a single wired signal carrying `bar_count` bands —
     needs the executor/port model to pass an array, not a scalar 0..1 curve
     (a genuine extension of `_fx_params`). Cleanest UI, biggest engine change.
  2. **A fixed set of value-input ports** `bar_1..bar_N`: fits the existing
     scalar-port model exactly, but `bar_count` is then capped by the declared
     ports and the node grows a lot of sockets.
  3. **Internally split one wired stem into bands**: the card takes one signal
     and does its own band-split — simplest wiring, but re-does analysis the
     signal pipeline already owns and loses per-band stem choice.
  Option 2 is the least-risk fit for today's contract; option 1 is the "right"
  long-term shape. Resolve this before implementing.
- A `tilt` port to slope the spectrum (bass-heavy ↔ treble-heavy) purely
  visually.
- `linear-mirror` doubling as a waveform-style centre band when few bars.
