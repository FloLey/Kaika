# Generative cards — the backlog (21 unbuilt cards)

A menu of **signal-reactive "content" cards** that broaden Kaika's vocabulary beyond the
fluid simulation. Each entry is a self-contained spec you can hand to an implementer.

**Nothing in this folder is built.** The six that WERE built — waves, lightning, fire,
aurora, rain, clouds — shipped and moved out: their design records are at
[`specs/generative-cards/`](../../specs/generative-cards/README.md), which is also the
honest place to see how far the shipped cards drifted from their specs.

So this is a **backlog, not a roadmap and not history**: nobody has committed to any of
these. Each spec is written against Kaika's real card contract (verified against the code
— see below), and every card is deliberately designed so its **vibe spans
elegant→energetic purely through its parameters** — no card is locked to one mood. Pick
the ones worth building; the spec is the starting point.

## The three build archetypes

Every card maps onto one of three shapes. The spec's tag (`[gen]` / `[fx]` /
`[either]`) and its "Template & effort" section say which.

| Archetype | I/O | Copy this card | Backend home |
|---|---|---|---|
| **`[gen]` source** | none → video | **`backdrop`** | a `sources.py` fn returning `(nframes, h, w, 4)` uint8 RGBA |
| **`[fx]` video→video** | video → video | **`transform`** | a handler that pulls upstream frames via `_video_source`, warps them |
| **stateful sim** | (either) | **`video` / `FluidClip`** | hold sim state across streamed blocks; `dag._closers.append(clip.close)` |

`[gen]` sources synthesise frames from scratch; their alpha channel occludes in
the `composite` alpha-over stack. `[fx]` cards restyle *whatever* is wired in
(an image card, a video card, even a fluid) — more flexible than owning an
upload, and matches the existing `transform` (affine + kaleidoscope) and
`stylize` (img2img) cards. **Stateful** is an add-on to either: cards whose
current frame depends on the previous one (reaction-diffusion, boids, video
feedback, the water height-field behind rain-on-water) must integrate across
blocks the way `FluidClip.advance(a, b)` does, so a streamed render matches a
whole-clip one.

## How a card plugs in (the shared contract)

**Ports** — the signal-drivable knobs — are declared **once** in
`backend/animation_params.py` → `SOURCE_PARAM_SPEC["<type>"]`, a list of
`{key, label, min, max, step, default, fmt}` (`fmt` ∈ `{dp2, deg, int, hz}`).
That single entry is the source of truth: it drives the executor's port
resolution (`_fx_params` maps each wired signal's 0..1 curve onto `[min, max]`
per frame → a length-`nframes` array) **and** the generated frontend table
(`make gen-params` → `fluidParams.js` → `nodeParams.ts`), so the UI slider range
can never drift from what the render maps. Non-modulatable settings (asset ref,
palette, mode toggles, symmetry counts, rows/cols) live in the card's **static
`data`**.

**Signals** any port can be wired to (each computed per *stem* × *frequency
band*, shaped to 0..1 with attack/release — `backend/signals.py`):

| Signal | What it follows |
|---|---|
| `energy` | loudness of the band |
| `onset` | transient hits / attacks |
| `flux` | how fast the spectrum is changing (busy-ness) |
| `brightness` | spectral centroid ≈ perceived pitch height |
| `harmonic` | tonal/pad vs percussive/noisy share |
| `chroma` | dominant pitch class (0..1 around the octave) |
| `beat` | beat phase, 0→1 each beat |
| `bar` | bar phase, 0→1 each bar |

The specs name these in their **Signal map** — the *natural* default wiring, not
a hard binding (any port takes any signal).

**Per-card wiring checklist** (the same for every card, so the specs don't
repeat it):

- **Backend**: add the `SOURCE_PARAM_SPEC` entry · write the `sources.py`
  render fn · register a whole-clip handler in `_VIDEO_HANDLERS` **and** a
  block handler in `_BLOCK_HANDLERS` (they must stay in lockstep) · run
  `make gen-params`.
- **Frontend**: `types.ts` node + data · `factories.ts` factory ·
  `graph/core.ts` `VIDEO_SOURCES` · `nodeParams.ts` · a `XxxNode.tsx`
  (copy `BackdropNode` for `[gen]`, `TransformNode` for `[fx]`) ·
  `registry.ts` entry (`category: "generators"`, `outFlow: "video"`).
- **Invariants**: a **Playground pipeline** demo (`card_demo.py` — bundle a
  dummy asset for `[fx]` cards) · a `paramHelp.ts` entry per modulatable port
  **and** a `Docs.tsx` section (both guarded by tests) · **do not** bump
  `RENDER_VERSION` (a new type doesn't change existing outputs) · bump
  `GRAPH_VERSION` + a `normalizeGraph` migration only if you later change a
  persisted card's shape.

See [`ARCHITECTURE.md`](../../ARCHITECTURE.md) and
[`DEVELOPMENT.md`](../../DEVELOPMENT.md) for the full engine and the add-a-node
checklist.

## The catalog

Effort: 🟢 stateless field (copy `backdrop`) · 🟡 drawing / remap / light state ·
🔴 stateful sim (FluidClip-style streaming).

> The catalog's first category — 🌊 **Natural / elemental**, cards 01–06 — is missing here
> because it is the one that got built. Those specs are at
> [`specs/generative-cards/`](../../specs/generative-cards/README.md); numbering picks up at 07.

### 🔊 Sound-native — `[gen]`
| # | Card | Effort | Pitch |
|---|---|---|---|
| 07 | [cymatics](07-cymatics.md) | 🟡 | Chladni nodal patterns; the shape *is* the frequency. |
| 08 | [vectorscope](08-vectorscope.md) | 🟡 | Glowing XY oscilloscope / waveform ribbon. |
| 09 | [spectrum-bars](09-spectrum-bars.md) | 🟢 | Linear or radial EQ bars from band signals. |

### ◼️ Geometric / retro-viz — `[gen]`
| # | Card | Effort | Pitch |
|---|---|---|---|
| 10 | [warp-tunnel](10-warp-tunnel.md) | 🟡 | Infinite polar tunnel, speed on energy, beat lurches. |
| 11 | [starfield](11-starfield.md) | 🟢 | Stars streaking from centre; beats burst. |
| 12 | [plasma](12-plasma.md) | 🟢 | Retro summed-sinusoid colour field. |
| 13 | [metaballs](13-metaballs.md) | 🟡 | Orbiting blobs merging organically. |
| 14 | [pulse-rings](14-pulse-rings.md) | 🟢 | Concentric rings emitted on every beat (radar). |
| 15 | [moire](15-moire.md) | 🟢 | Two grids sliding over each other, shimmering. |
| 16 | [spirograph](16-spirograph.md) | 🟡 | Decaying harmonograph curve traced over the clip. |

### 🌱 Organic growth — `[gen]`
| # | Card | Effort | Pitch |
|---|---|---|---|
| 17 | [reaction-diffusion](17-reaction-diffusion.md) | 🔴 | Gray–Scott spots↔stripes↔mazes morphing. |
| 18 | [boids](18-boids.md) | 🔴 | A murmuration of particles on a flow field. |
| 19 | [lsystem](19-lsystem.md) | 🟡 | A tree/vine that branches and blooms on beats. |
| 20 | [lenia](20-lenia.md) | 🔴 | Smooth-life continuous cellular creatures. |

### 🖼️ Video→video FX — `[fx]`
| # | Card | Effort | Pitch |
|---|---|---|---|
| 21 | [taquin](21-taquin.md) | 🟡 | Sliding-tile puzzle scrambling & solving the input on beats. |
| 22 | [rain-refraction](22-rain-refraction.md) | 🔴 | Droplet ripples distort the underlying image/video. |
| 23 | [mosaic-tileflip](23-mosaic-tileflip.md) | 🟡 | Tiles flip / rotate / pulse on beats. |
| 24 | [pixel-sort](24-pixel-sort.md) | 🟡 | Row pixel-sorting, RGB split, glitch on transients. |
| 25 | [shatter](25-shatter.md) | 🟡 | Fractures into shards that explode on beats. |
| 26 | [voronoi-mosaic](26-voronoi-mosaic.md) | 🟡 | Stained-glass cells that pulse & scatter (`[either]`). |
| 27 | [video-feedback](27-video-feedback.md) | 🔴 | Recursive zoom/rotate echo — the classic trails tunnel. |
