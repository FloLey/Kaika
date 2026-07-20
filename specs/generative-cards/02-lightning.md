# 02 — Lightning   `[gen]` · effort 🟡 · Natural / elemental

## Concept

Jagged branching bolts crack across a dark sky, each strike blooming a soft glow
and a momentary full-frame flash that decays over a few frames. At rest it's the
occasional distant fork on the horizon; pushed, it's a strobing electric storm
firing on every transient. The bolt colour runs from cold blue-white to violet.

**Elegant↔energetic range:** low `strike` rate + thin low-`branchiness` arcs +
gentle `afterglow` = rare, dramatic bolts; high `strike` + thick forked bolts +
strong `glow`/`flash` = a relentless strobe. Same card.

## Signal map

| Signal | Natural target |
|---|---|
| `onset` (drums) | `strike` — a rising edge fires a new bolt |
| `energy` | `branchiness` + bolt thickness — bigger hits, angrier bolts |
| `brightness` | colour temperature (blue-white ↔ violet) |
| `flux` | `jitter` — how erratic the bolt path is |

## Ports

| key | label | range | default | effect |
|---|---|---|---|---|
| `strike` | strike | 0..1 | 0.0 | rising past 0.5 spawns a bolt this frame (edge-triggered) |
| `branchiness` | branches | 0..1 | 0.4 | probability/count of forks off the main bolt |
| `thickness` | thickness | 0.5..6 px | 1.5 | core bolt line width |
| `glow` | glow | 0..1 | 0.5 | additive gaussian bloom radius/intensity |
| `flash` | flash | 0..1 | 0.4 | full-frame white flash strength on a strike |
| `afterglow` | afterglow | 0..1 | 0.5 | how many frames a bolt lingers & fades |
| `jitter` | jitter | 0..1 | 0.5 | path randomness (midpoint-displacement amplitude) |
| `hue` | hue | 0..1 | 0.6 | bolt colour (0.6≈blue → 0.8≈violet) |
| `opacity` | opacity | 0..1 | 1.0 | layer alpha |

## Static data

- `origin`: `"top"` / `"random"` / `"center"` — where bolts start.
- `seed`: int.

## Backend algorithm

Stateless if we derive all randomness from `(seed, frame_index)`, so it copies
`backdrop`. The only "memory" is afterglow, which we resolve **without** state by
rendering the last few strikes' decayed contribution each frame:

1. **Detect strikes** ahead of the loop: from the full-segment `strike` array
   (available in the block handler before slicing), find rising edges past 0.5 →
   a list of `(strike_frame, rng_seed)`. This is the whole "when" story; it needs
   no per-frame state.
2. **Bolt geometry** per strike: midpoint-displacement between `origin` and a
   random ground point (recursive subdivision, amplitude = `jitter`), plus forks
   spawned with prob `branchiness`. Rasterise into an RGBA scratch with PIL
   `ImageDraw.line` at `thickness`.
3. **Per frame `i`**: composite every strike whose `strike_frame ≤ i` within the
   `afterglow` window, each scaled by a decay `exp(-(i-strike_frame)/τ)` where τ
   scales with `afterglow`. Add a gaussian-blurred copy (`scipy.ndimage`) for
   `glow`. Add `flash × decay` as a flat white wash.
4. Colour from `hue`; alpha = `opacity` combined with the bolt/glow coverage.

Because strikes are found from the full array and decay is a pure function of
`i − strike_frame`, block `[a,b]` renders identically whether or not earlier
blocks ran — no `FluidClip` needed.

## Frontend card

Copy `BackdropNode.tsx` + an `origin` `<select>`. The `strike` port is a
trigger-style knob (like the slideshow `trigger`); document that in `paramHelp`.

## Template & effort

Copy **`backdrop`**. 🟡 for the geometry (recursive bolt + fork rasterising, blur
bloom); no sim state.

## Playground demo

`lightning` → `output`, `onset` (drums) wired to `strike`, `energy` to
`branchiness`. Dark by default so it reads on black.

## Variants / open questions

- `ground_flash`: illuminate a bottom gradient on each strike (silhouette look).
- `fork_taper`: thin the forks vs the main channel for realism.
- Pair with `04-aurora` or `06-clouds-nebula` under it in a stack combine for a
  full stormy sky.
