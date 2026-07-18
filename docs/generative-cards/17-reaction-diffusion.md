# 17 — Reaction–diffusion   `[gen]` · effort 🔴 · Organic growth

## Concept

Two chemicals diffuse across the frame and react — feeding, killing, spreading —
and out of that simple rule grow **living Turing patterns**: spots, stripes,
coral, mazes, fingerprints, all slowly morphing into one another as the
feed/kill rates drift. Gray–Scott is the canonical recipe. It never repeats and
it always looks *grown*, not drawn — a mesmerising organic bed layer.

**Elegant↔energetic range:** low `feed`/`kill` with slow drift = soft coral
blobs bleeding into one another over a whole verse; high rates + strong `inject`
= a fast writhing maze that tears itself apart and reorganises on every beat.

## Signal map

| Signal | Natural target |
|---|---|
| `brightness` | `kill` — selects the pattern regime (spots↔stripes) |
| `harmonic` | `feed` — the other regime axis (mazes↔coral) |
| `energy` | `inject` — chemical disturbance stirs the field |
| `beat` | brief `inject` splashes (a squirt of reagent on the hit) |

## Ports

| key | label | range | default | effect |
|---|---|---|---|---|
| `feed` | feed | 0.01..0.08 | 0.037 | feed rate F — how fast B is replenished |
| `kill` | kill | 0.04..0.07 | 0.06 | kill rate k — with F, selects the pattern |
| `inject` | inject | 0..1 | 0.2 | random reagent disturbance strength |
| `flow` | flow | 0.2..1.5 | 1.0 | diffusion ratio Da/Db (pattern scale) |
| `palette_shift` | colour | 0..1 | 0.0 | rotate the palette ramp |
| `contrast` | contrast | 0..1 | 0.5 | sharpness of the B→colour mapping |
| `opacity` | opacity | 0..1 | 1.0 | layer alpha |

## Static data

- `palette`: `"coral"` / `"ink"` / `"acid"` / `"mono"` — the ramp B maps through.
- `sim_scale`: sim grid resolution (e.g. ½ of output; the low-res chemical grid
  upsamples smoothly, and the sim cost is quadratic in it).
- `seed`: int — initial seeding of B blobs and the `inject` noise.

## Backend algorithm — **stateful** (copies `backdrop` I/O + `FluidClip` streaming)

The chemical grid evolves from its own previous state, so blocks must run
**sequentially** and carry `A`, `B`, exactly like `FluidClip.advance(a, b)`.

1. **Setup** (`_reaction_diffusion_block`): resolve params
   (`dag._fx_params(node)`) and allocate two float grids `A` (≈1.0) and `B`
   (seeded with a few blobs from `seed`) at `sim_scale`. State lives in the
   block handler's closure.
2. **Gray–Scott update** per frame: Laplacians `Lap(A)`, `Lap(B)` via a 3×3
   stencil (`scipy.ndimage.convolve` with the classic `[[.05,.2,.05],[.2,-1,.2],
   [.05,.2,.05]]` kernel), then
   `A += (Da·Lap(A) − A·B² + feed·(1−A))·dt` and
   `B += (Db·Lap(B) + A·B² − (kill+feed)·B)·dt`, with `Da/Db` set by `flow`.
   `feed`/`kill` are read per-frame from the wired ports (a slow drift through
   regimes is what makes it morph). `inject` adds a splash of B noise.
3. **Colour**: map `B` (raised to `contrast`) through the palette, rotated by
   `palette_shift`; alpha follows `B` so quiet regions are transparent.
   `opacity` scales alpha. Upsample to output size. Return `(nframes, h, w, 4)`.

**Streaming contract**: `produce(a, b)` advances the sim from where the last
block left off (`A`, `B` in the closure). Blocks arrive front-to-back and
contiguous (the render engine guarantees it, same as fluid), so the streamed
result equals a whole-clip render. The whole-clip handler runs the same loop
over `[0, nframes]`. Register any resources via `dag._closers.append(...)`;
because the sim is expensive it's a **good candidate for the raw-frame cache**.

## Frontend card

Copy `BackdropNode.tsx` + a `palette` `<select>`. Previews as a standalone
generator (no upstream input).

## Template & effort

Copy **`backdrop`** for the I/O + **`FluidClip`** for the stateful streaming.
🔴 — a genuine time-integrated reaction–diffusion sim; `sim_scale` trades speed
for detail and should default modestly.

## Playground demo

`reaction-diffusion` → `output`, `brightness` → `kill`, `harmonic` → `feed`,
`beat` → `inject`.

## Variants / open questions

- Expose `dt` / iterations-per-frame as a static — more sub-steps = faster
  evolution without a bigger grid.
- A `flow_field` variant that advects the chemicals along curl noise (drifting
  patterns) — nudges cost up but looks alive.
- Preset "regime tours" that sweep `feed`/`kill` along the famous Pearson map so
  a single knob walks spots→worms→mazes.
