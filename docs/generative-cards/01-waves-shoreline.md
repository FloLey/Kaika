# 01 — Waves / shoreline   `[gen]` · effort 🟡 · Natural / elemental

## Concept

The ocean seen from directly above, meeting a beach: bands of swell march up the
frame, thin to a translucent sheet of foam as they break, wash up a wet sand
gradient, then retreat. It reads as calm and cinematic at rest and turns into a
churning, foam-streaked storm surf when pushed. Colours run from deep teal at the
"deep water" edge to pale foam at the wash line, over a warm sand base.

**Elegant↔energetic range:** long low swell + slow arrival rate + soft foam = a
meditative tide; short steep waves + fast arrival + heavy foam + a windy diagonal
= crashing surf. Both are the same card at different parameter values.

## Signal map

| Signal | Natural target |
|---|---|
| `energy` (drums/bass) | swell height — louder = taller crests |
| `beat` | wave arrival — one crest crosses per beat when `wave_rate` follows it |
| `flux` | choppiness / cross-hatching of secondary wavelets |
| `brightness` | palette warmth (cool storm ↔ warm golden-hour) |

## Ports

| key | label | range | default | effect |
|---|---|---|---|---|
| `swell` | swell | 0..1 | 0.35 | crest amplitude (foam threshold scales with it) |
| `wave_rate` | wave rate | 0.1..4.0 hz | 0.6 | wavefronts per second advancing up-frame |
| `choppiness` | choppiness | 0..1 | 0.25 | weight of the cross-direction secondary waves |
| `foam` | foam | 0..1 | 0.5 | foam coverage above the crest threshold + on the wash line |
| `wind_angle` | wind angle | 0..360 deg | 90 | direction the swell travels (90 = up-frame) |
| `shore` | shore line | 0..1 | 0.8 | where the sand begins (fraction up the frame) |
| `warmth` | warmth | 0..1 | 0.5 | palette temperature (teal-grey ↔ golden) |
| `opacity` | opacity | 0..1 | 1.0 | layer alpha in the composite stack |

## Static data

- `palette`: named ramp (`"ocean"`, `"tropical"`, `"storm"`, `"sunset"`) picking
  the deep-water / foam / sand triple; `warmth` interpolates within it.
- `seed`: int, so two wave cards differ.

## Backend algorithm

Stateless per frame — a closed-form height field, no integration, so it copies
`backdrop` exactly (whole-clip + block handler, no `FluidClip`).

1. Precompute a normalized grid `(Y, X)` once (`np.meshgrid`, 0..1).
2. **Height field** at time `t = frame_index / fps`: sum of a few Gerstner/sine
   wavefronts travelling along `wind_angle`, wavelengths set so ~4–8 crests fit
   the frame, phase advancing at `wave_rate`. Add `choppiness ×` a rotated
   secondary set for cross-hatching. `swell` scales the sum.
   `h = Σ_k a_k · sin(k·(X·cosθ + Y·sinθ) − 2π·wave_rate·t·k + φ_k)`.
3. **Shore mask**: everything above `shore` (up-frame) is wet/dry sand; blend the
   water into the sand with a soft edge whose position wobbles with `h` (the wash
   line advancing and retreating).
4. **Colour**: map `h` through the palette ramp (deep→mid water); where
   `h > crest_threshold(swell)` **or** near the wash line, lerp toward foam white
   by `foam`. Sand region = the sand colour, darkened where recently wet.
5. Alpha = `opacity`. Return `(nframes, h, w, 4)` uint8.

All per-frame ops are vectorised numpy; a 1080p frame is a handful of `sin` over
a `(H, W)` array. Foam texture = threshold on a cheap value-noise field
(reuse the noise helper the `noise` modulator already uses, or a small FFT-based
one) modulated by `h`.

## Frontend card

Copy `BackdropNode.tsx`: `NodeFrame` with a `video` out port and the
`NODE_PARAMS.map(ParamRow)`. Add a small palette `<select>` bound to
`data.palette` (like the video card's `fit` select). No BoxPad (full-frame).

## Template & effort

Copy **`backdrop`** (source, whole-clip + block, stateless). 🟡 not 🟢 only
because the height field + foam/shore shading is real graphics work; there is no
sim state and no asset, so streaming is trivial (`frame_offset` → `t`).

## Playground demo

`waves` card → `output`, with an `energy` signal (drums) wired to `swell` and a
`beat` signal to `wave_rate`. No asset needed.

## Variants / open questions

- Add a `sun_glint` port: a specular highlight band that tracks `brightness`.
- A `foam_persistence` that leaves receding foam trails (would make it mildly
  stateful — keep off by default to stay 🟡).
- Could expose `crest_sharpness` to go from sine swell to near-breaking Gerstner
  peaks.
