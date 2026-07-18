# 13 — Metaballs   `[gen]` · effort 🟡 · Geometric / retro-viz

## Concept

Organic lava-lamp blobs: a handful of circles orbit the frame, and where their
soft inverse-square fields overlap they bulge toward each other, merge into a
single gooey mass, then stretch and snap apart as they drift on. The thresholded
isosurface gives the signature liquid-metal edge. Reads as a few big slow blobs
lazily merging at rest and a swarm of small fast droplets pulsing on the beat
when pushed.

**Elegant↔energetic range:** low `count` + big `radius` + slow `orbit_speed` +
soft `edge` = a calm lava lamp; high `count` + small radius + fast orbit + a
`beat`-driven `radius` pulse = a boiling froth of merging droplets.

## Signal map

| Signal | Natural target |
|---|---|
| `energy` (bass/drums) | `radius` — the blobs swell with loudness |
| `beat` | `radius` pulse — every beat inflates them briefly |
| `flux` | `orbit_speed` — busier music orbits them faster |
| `brightness` | `hue` shift |

## Ports

| key | label | range | default | effect |
|---|---|---|---|---|
| `count` | count | 2..24 | 6 | number of orbiting balls (integer) |
| `radius` | radius | 0..1 | 0.4 | field strength / blob size |
| `threshold` | threshold | 0..1 | 0.5 | isosurface level (fill coverage) |
| `orbit_speed` | orbit speed | 0..4 | 1.0 | how fast the balls circle |
| `glow` | glow | 0..1 | 0.3 | gaussian bloom around the surface |
| `hue` | hue | 0..1 | 0.55 | palette rotation |
| `opacity` | opacity | 0..1 | 1.0 | layer alpha |

## Static data

- `seed`: int — seeds each ball's orbit radius, phase, and rate.
- `edge`: `"hard"` / `"soft"` — a crisp liquid-metal boundary vs a smoky glow.
- `palette`: named ramp (`"mercury"`, `"lava"`, `"toxic"`, `"mono"`); `hue`
  rotates within it.

## Backend algorithm

Fully stateless — every ball centre is a closed form in `t = frame_index / fps`,
so it copies `backdrop` (whole-clip + block handler, no `FluidClip`).

1. **Ball orbits** built once from `seed`: ball `i` gets an orbit centre, orbit
   radius `ρ_i`, phase `φ_i`, and rate `ω_i` (reuse the `(seed, i)` hashing the
   `noise` modulator uses). Its centre at time `t` is
   `(cx_i, cy_i) = orbit_i + ρ_i·(cos(orbit_speed·ω_i·t + φ_i),
   sin(orbit_speed·ω_i·t + φ_i))` — deterministic, no state.
2. **Field sum** (the metaball kernel), vectorised over balls:
   `F(x, y) = Σ_i (radius·s_i)² / ((x − cx_i)² + (y − cy_i)² + ε)`. Broadcast the
   grid against the `count` centres and sum along the ball axis — one `(H, W)`
   array out, no Python loop over pixels.
3. **Isosurface**: `mask = smoothstep(threshold − w, threshold + w, F)` where the
   edge width `w` is tiny for `edge="hard"`, wide for `"soft"`. This is the
   gooey merge — neighbouring balls share field so the level set bulges between
   them.
4. **Colour** `F` (or the surface distance) through the palette (`hue` rotates
   it); add a gaussian-blurred copy (`scipy.ndimage`) scaled by `glow`. Alpha =
   `mask · opacity`. Return `(nframes, h, w, 4)` uint8.

Cost is `count × H × W` for the field sum — fine for ≤24 balls at 1080p because
it's one broadcast, not a loop. Nothing carried across frames or blocks.

## Frontend card

Copy `BackdropNode.tsx` + an `edge` `<select>` and a `palette` `<select>`.
Full-frame, no BoxPad. `count` renders as an integer stepper (`fmt: int`).

## Template & effort

Copy **`backdrop`**. 🟡 for the field sum + isosurface shading + bloom; no sim
state, no asset.

## Playground demo

`metaballs` → `output`, `energy` (bass) → `radius`, `beat` → `radius` (a second
wired signal for the pulse), `flux` → `orbit_speed`. No asset needed.

## Variants / open questions

- Negative balls (subtractive field) that bore holes through the mass — a `holes`
  static count.
- `trail`: leave a fading wake behind each ball (mildly stateful — keep off to
  stay 🟡).
- A `chrome` shading mode (fake reflection ramp keyed on the field gradient) for
  a liquid-metal T-1000 look.
