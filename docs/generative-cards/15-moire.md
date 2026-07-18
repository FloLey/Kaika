# 15 — Moiré   `[gen]` · effort 🟢 · Geometric / retro-viz

## Concept

Moiré interference: two overlaid periodic grids — lines, dots, or concentric
rings — whose relative offset and rotation are signal-driven, so tiny movements
of one grid against the other produce huge, slow, shimmering interference fringes
that sweep across the frame. The magic is the amplification: a sub-pixel nudge
becomes a frame-spanning band. Reads as slow hypnotic breathing fringes at rest
and a fast writhing optical-illusion churn when pushed.

**Elegant↔energetic range:** small angle difference + slow `offset` drift + fine
`pitch` = large calm fringes rolling gently; large angle difference + fast
`offset` + coarse pitch + high `contrast` = a fast writhing psychedelic weave.

## Signal map

| Signal | Natural target |
|---|---|
| `energy` (any stem) | `offset` — loudness slides one grid against the other |
| `flux` | `angle_b` — busier music twists the relative angle |
| `brightness` | `hue` shift |
| `bar` | `offset` drift — a slow sweep over the bar |

## Ports

| key | label | range | default | effect |
|---|---|---|---|---|
| `pitch` | pitch | 2..80 | 20 | grid spacing (period in px) of both grids |
| `angle_a` | angle A | 0..180 deg | 0 | rotation of the first grid |
| `angle_b` | angle B | 0..180 deg | 8 | rotation of the second grid |
| `offset` | offset | 0..1 | 0.0 | phase slide of grid B relative to grid A |
| `hue` | hue | 0..1 | 0.0 | palette rotation |
| `contrast` | contrast | 0..1 | 0.6 | fringe hardness (soft ↔ hard bands) |
| `opacity` | opacity | 0..1 | 1.0 | layer alpha |

## Static data

- `pattern`: `"lines"` / `"dots"` / `"concentric"` — the periodic mask each grid
  is built from (parallel lines, a dot lattice, or concentric rings).
- `palette`: named ramp (`"mono"`, `"neon"`, `"duotone"`); `hue` rotates within
  it.
- `seed`: int — offsets the second grid's centre so `"concentric"` beats.

## Backend algorithm

Fully stateless — the interference field is a closed form in `t = frame_index /
fps` via the wired `offset`/angles, so it copies `backdrop` (whole-clip + block
handler, no `FluidClip`).

1. **Precompute the grid** `(Y, X)` once.
2. **Grid A**: a periodic mask along its rotated axis, e.g.
   `A = sign(sin( (2π/pitch)·(X·cos θ_a + Y·sin θ_a) ))` for `"lines"`; for
   `"dots"` multiply the sine along both rotated axes; for `"concentric"` use
   `sin((2π/pitch)·hypot(X − cx, Y − cy))`.
3. **Grid B**: the same construction at `angle_b`, with the phase shifted by
   `offset·2π` — this is the slide that drives the fringes.
4. **Interference**: combine the two masks — `A · B` (multiply) or `A ⊕ B`
   (xor-like on the binary masks) → a `(H, W)` field where the beat frequency of
   the two grids surfaces as the large fringe pattern. `contrast` pushes it
   through a smoothstep.
5. **Colour** through the palette (`hue` rotates it). Alpha = `opacity`. Return
   `(nframes, h, w, 4)` uint8.

Pure vectorised numpy — two `sin` masks and a multiply over `(H, W)`. Nothing is
carried between frames or blocks; motion comes entirely from the wired
`offset`/`angle_b` curves (and any static drift folded into `offset`).

## Frontend card

Copy `BackdropNode.tsx` + a `pattern` `<select>` and a `palette` `<select>`.
Full-frame, no BoxPad. `angle_a`/`angle_b` use `fmt: deg`.

## Template & effort

Copy **`backdrop`**. 🟢 — two closed-form masks and a multiply; no geometry
drawing, no state, no asset.

## Playground demo

`moire` → `output`, `energy` → `offset`, `flux` → `angle_b`. No asset needed.

## Variants / open questions

- A third grid for triple-moiré (denser, more chaotic fringes).
- Let grid B sample a wired image as its mask — turns it `[fx]`; keep the
  procedural default here.
- `zoom` mismatch (slightly different `pitch` per grid) is another classic moiré
  source — could fold into a `pitch_b` port.
