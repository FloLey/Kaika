# 20 — Lenia (smooth-life)   `[gen]` · effort 🔴 · Organic growth

## Concept

Lenia is a continuous cellular automaton — Conway's Life made smooth in space,
time and state — whose gliding, pulsing "creatures" (the famous *orbium*) look
genuinely alive: soft luminous blobs that crawl across the frame, split, merge,
and die. It is the most convincingly *organic* of all these cards.

**Elegant↔energetic range:** a single serene orbium gliding slowly across a dark
field = hypnotic; a teeming colony reproducing and colliding, agitated by
`beat`-driven nutrient pulses = a churning petri dish.

## Signal map

| Signal | Natural target |
|---|---|
| `energy` | `growth_mu` — the growth-function centre (excitability) |
| `flux` | `radius` — kernel radius (creature scale / speed) |
| `beat` | nutrient pulse (a perturbation that stirs the colony) |
| `brightness` | `palette_shift` — spectral height tints the creatures |

## Ports

| key | label | range | default | effect |
|---|---|---|---|---|
| `growth_mu` | growth μ | 0.1..0.3 | 0.15 | centre of the growth function |
| `growth_sigma` | growth σ | 0.01..0.05 | 0.017 | width of the growth function |
| `radius` | radius | 8..24 | 13 | kernel ring radius (creature scale) |
| `dt` | dt | 0.02..0.2 | 0.1 | integration step (evolution speed) |
| `palette_shift` | colour | 0..1 | 0.0 | rotate the palette ramp |
| `opacity` | opacity | 0..1 | 1.0 | layer alpha |

## Static data

- `palette`: `"bio"` / `"plasma"` / `"mono"` — the ramp the continuous state
  maps through.
- `sim_scale`: sim grid resolution (the state upsamples; cost is the FFT size).
- `seed`: int — the initial creature (a seeded orbium patch) and any noise.

## Backend algorithm — **stateful** (copies `backdrop` I/O + `FluidClip` streaming)

The continuous grid evolves from its own previous state, so blocks must run
**sequentially** and carry it, exactly like `FluidClip.advance(a, b)`.

1. **Setup** (`_lenia_block`): allocate one float grid `state ∈ [0,1]` at
   `sim_scale`, seed a creature from `seed`, and precompute the ring kernel `K`
   (a smooth annulus at `radius`, normalised) and its FFT. Params via
   `dag._fx_params(node)`. State lives in the block handler's closure.
2. **Lenia update** per frame: convolve `state` with `K` via **FFT convolution**
   (`numpy.fft`, exactly the way fluid's Poisson step works), giving the
   neighbourhood potential `U`; apply the smooth growth function
   `G(U) = 2·exp(−(U−growth_mu)² / (2·growth_sigma²)) − 1`; integrate
   `state = clip(state + dt·G(U), 0, 1)`. `beat` frames add a nutrient
   perturbation. Rebuild `K` only when `radius` changes meaningfully.
3. **Colour**: map `state` through the palette (rotated by `palette_shift`);
   alpha follows `state` so empty space is transparent. `opacity` scales it.
   Upsample to output. Return `(nframes, h, w, 4)`.

**Streaming contract**: `produce(a, b)` advances the grid from where the last
block left off (`state` in the closure). Blocks arrive front-to-back and
contiguous (the render engine guarantees it, same as fluid), so the streamed
result equals a whole-clip render. The whole-clip handler runs the same loop
over `[0, nframes]`. Register resources via `dag._closers.append(...)`; because
the FFT sim is expensive it's a **good candidate for the raw-frame cache**.

## Frontend card

Copy `BackdropNode.tsx` + a `palette` `<select>`. Previews as a standalone
generator.

## Template & effort

Copy **`backdrop`** for the I/O + **`FluidClip`** for the stateful streaming.
🔴 — an FFT convolution per frame plus the growth integration; the priciest of
the four organic cards.

## Playground demo

`lenia` → `output`, `energy` → `growth_mu`, `flux` → `radius`,
`beat` → (nutrient pulse).

## Variants / open questions

- **Stability caveat**: Lenia is fragile — the wrong `growth_mu`/`sigma`/`dt`
  either dissolves to zero or blows up to a full grid. Clamp `state` every step,
  keep the wired ranges inside the known-stable window above, and detect a dead
  grid (sum→0) to auto-reseed. Document this.
- Multi-channel Lenia (RGB kernels) → colourful multi-species colonies — richer,
  3× the FFT cost.
- A `reseed` on `bar` that drops a fresh orbium so the frame never empties out.
- Expose sub-steps per frame (more `dt` integrations) to speed up evolution
  without a larger grid.
