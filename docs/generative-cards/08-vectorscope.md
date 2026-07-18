# 08 — Vectorscope   `[gen]` · effort 🟡 · Sound-native

## Concept

A glowing XY oscilloscope: a beam plots a point at `(sigX, sigY)` every
sub-frame and the successive points join into a luminous phosphor trail that
decays behind it — an analog scope, or a Lissajous figure being drawn live by
the music. In `waveform` mode it instead lays the audio envelope out as a
ribbon across the frame. This turns the curve-only **Scope** modulator (which
only draws a debug trace) into an actual video **producer**.

**Elegant↔energetic range:** slow, smooth signals on X/Y trace clean closed
Lissajous loops with a long `persistence` tail; fast, `flux`-jittered signals
scribble a bright tangle that fills the frame and never settles. Same card.

## Signal map

| Signal | Natural target |
|---|---|
| *(wired)* signal A | X deflection (`gain_x`) — the beam's horizontal drive |
| *(wired)* signal B | Y deflection (`gain_y`) — the beam's vertical drive |
| `energy` | beam brightness — louder = hotter trace |
| `flux` | trail `jitter` — busy spectra shake the beam path |
| `beat` | `rotate` kicks — snap the figure round on the beat |

## Ports

| key | label | range | default | effect |
|---|---|---|---|---|
| `gain_x` | gain X | 0..2 | 1.0 | horizontal deflection scale of the X signal |
| `gain_y` | gain Y | 0..2 | 1.0 | vertical deflection scale of the Y signal |
| `persistence` | persistence | 0..1 | 0.7 | phosphor trail length (decay per frame) |
| `rotate` | rotate | 0..360 | 0 | rotation of the whole figure |
| `glow` | glow | 0..1 | 0.5 | additive gaussian bloom on the beam |
| `hue` | hue | 0..1 | 0.45 | beam colour through the palette |
| `opacity` | opacity | 0..1 | 1.0 | layer alpha |

## Static data

- `mode`: `"xy"` (Lissajous) / `"waveform"` (envelope ribbon) / `"spiral"`
  (radius = one signal, angle = time) — the plotting geometry.
- `draw`: `"line"` (connected beam) / `"dots"` (discrete samples).
- `seed`: int — seeds the `jitter`.

## Backend algorithm

Mildly stateful (the phosphor trail carries between frames), but we keep it
**stateless per block** using the analytic-decay-window trick from
`02-lightning`: instead of a buffer carried across blocks, render the trailing
contribution from a fixed window of recent sub-frames with a closed-form decay,
so a streamed block matches a whole-clip render exactly. → copies `backdrop`.

1. **Sub-sample the beam path**: the X/Y port arrays are one value per frame;
   interpolate `K` sub-frame points per frame (`K` ~ 8) so the trace is smooth
   between frames. Apply `gain_x`/`gain_y`, `rotate`, and a `flux`-scaled
   `jitter` (from `seed + sub-index`). In `waveform` mode the X axis is time and
   Y is the single wired signal; in `spiral` mode radius/angle map instead.
2. **Beam raster** per frame `i`: draw the sub-frame points for this frame into
   an RGBA scratch with PIL `ImageDraw.line` (or points, per `draw`), intensity
   scaled by `energy`.
3. **Phosphor trail without state**: composite the beam rasters of the last `W`
   frames (`W` fixed by `persistence`), each scaled by
   `persistence^(i − j)` for source frame `j ≤ i`. Because the decay is a pure
   function of `i − j` and every needed source frame lies inside the block's
   accessible range, block `[a, b]` renders identically standalone — no
   `FluidClip`.
4. Add a gaussian-blurred copy (`scipy.ndimage`) for `glow`; colour from `hue`.
   Alpha = trace coverage × `opacity`. Return `(nframes, h, w, 4)` uint8.

If `persistence → 1` needs a window longer than a block, fall back to a proper
decaying buffer carried across blocks (copies `FluidClip`, → 🔴) — kept off the
default path.

## Frontend card

Copy `BackdropNode.tsx` + a `mode` `<select>` and a `draw` `<select>`. Note in
`paramHelp` that this card wants **two** signals wired (X and Y) to do anything
interesting — one wired input alone traces a flat line in `xy` mode.

## Template & effort

Copy **`backdrop`**. 🟡 for the sub-frame interpolation, beam rasterising and the
analytic-decay window; stays stateless-per-block by construction, so no
`FluidClip`.

## Playground demo

`vectorscope` → `output`, two signals (e.g. bass `energy` → `gain_x`, vocal
`brightness` → `gain_y`), `energy` → nothing else. `mode: xy`. No asset needed.

## Variants / open questions

- A `grid` static drawing scope graticule / centre-cross behind the beam for the
  full instrument look.
- `channels`: three beams in R/G/B from three wired signals, offset — a stacked
  multi-scope.
- `waveform` mode could read the raw stem envelope directly if the executor
  exposes it, rather than a shaped 0..1 signal — flag as an executor question.
