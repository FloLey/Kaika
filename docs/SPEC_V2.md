# Kaika 開花 — Spec v2 : Recipe-driven simulation, live studio, chat copilot

*Spec v2.0 · extends [SPEC.md](SPEC.md) (v0.2) · status: draft, to be challenged*

**Author:** Florent Lejoly · **Date:** 11 June 2026

v0.2 proved the pipeline: audio → score → fluid → (diffusion) → clip. v2 reworks the
*creative control layer* around three findings from using it:

1. **The audio is under-used.** Mid onsets, beats, tempo, and the band-energy split are
   computed but drive nothing. Chroma (pitch content) isn't extracted at all. More signal
   = more audio/visual coherence.
2. **The mapping is hardcoded.** Kicks are always `palette[0]` jets from a center anchor;
   hats are always random scattered darts; a dozen "feel" constants (`AMBIENT_FLOOR`,
   `JET_FRACTION`, `SOURCE_DECAY`, …) live in `simulate.py`, invisible to recipes. The
   recipe should describe **exactly** what is rendered — every element changeable —
   instead of tuning the edges of a fixed behavior.
3. **Iteration is blind.** You change YAML, run a preview, wait. The studio should show
   the audio and the simulation side by side, and a parameter change should be visible
   in seconds. On top of that, a chat assistant edits the recipe through tools, so
   "at 2s I want 3 sources aligned horizontally in the center" is one sentence, not a
   YAML session.

**Core invariants kept from v0.2:** determinism (seed → identical video), one continuous
simulation with per-segment parameter smoothing, everything-on-disk reproducibility
(`runs/<id>/`), the E3/E4 boundary, CLI second-class to the UI.

---

## Table of contents

1. [Score v2 — extract more from the sound](#1--score-v2)
2. [Recipe v2 — the document that describes the render](#2--recipe-v2)
   - [Canvas (dimensions & orientation)](#21--canvas)
   - [Emitters (sources: triggers, placement, color, body)](#22--emitters)
   - [Modulators (signal → parameter routing)](#23--modulators)
   - [Timeline (authored directives)](#24--timeline)
   - [Field & render (all constants exposed)](#25--field--render)
   - [Migration from v1](#26--migration)
3. [Engine changes (E2)](#3--engine-changes)
4. [Studio v2 — live parameter loop](#4--studio-v2)
5. [Chat copilot — LLM with recipe tools](#5--chat-copilot)
6. [API changes](#6--api-changes)
7. [Milestones](#7--milestones)
8. [Risks & open questions](#8--risks--open-questions)

---

## 1 · Score v2

**Goal: everything the analysis can cheaply know about the track is available as a
named, frame-aligned signal that recipes can route anywhere.**

### 1.1 New per-frame signals (added to `FrameData`)

| Signal | Method | Why |
| --- | --- | --- |
| `chroma` (12 floats) | `librosa.feature.chroma_cqt`, normalized | pitch content → hue, harmony-driven color |
| `chroma_argmax` (0–11) | dominant pitch class | discrete "musical key of the moment" for color/position |
| `flux` | spectral flux (onset envelope, normalized 0–1) | continuous "business" signal, snappier than RMS |
| `beat_phase` (0–1) | phase between consecutive beats | pulsing/breathing exactly on the grid |
| `bar_phase` (0–1) | phase within a 4-beat bar | slower breathing, camera-like drift cycles |
| `harmonic_ratio` (0–1) | HPSS energy split harmonic/(h+p) | pads vs percussion → soft vs sharp visuals |

Existing signals stay: `rms`, `centroid_hz`, `bands[low,mid,high]`.

### 1.2 Events

- `onsets.mid` is **kept and now consumed** (default v2 recipe gives mids their own
  emitter).
- `beats` are **kept and now consumable** as an emitter trigger (`type: beat`,
  `every: N`) and as the source of `beat_phase`.
- Band edges (150 Hz / 4000 Hz) become recipe-readable analysis settings
  (`analysis.bands: [150, 4000]`) so a bass-heavy track can move the split. Changing
  them invalidates `score.json` (re-analysis required; the UI does it transparently).

### 1.3 Format

`score.json` gets `"version": 2`. v1 scores load fine (new fields default to
empty/zero); the UI offers "re-analyze" when a v2-only feature is referenced.

---

## 2 · Recipe v2

**The recipe is the complete, declarative description of the render.** Reading it tells
you exactly what happens; editing any value changes exactly one thing. No behavior
lives only in code: everything `simulate.py` currently hardcodes becomes a recipe field
with the current constant as its default.

Top-level shape:

```yaml
version: 2
name: eclosion
seed: 4217

canvas:     { … }     # dimensions, orientation, fps          (NEW)
analysis:   { … }     # band edges, onset sensitivity         (NEW)
field:      { … }     # solver + ambient motion (constants exposed)
render:     { … }     # exposure, bloom, background, palette handling
palettes:   { … }     # named palettes                        (NEW: plural, named)
emitters:   [ … ]     # the sources — the heart of v2         (NEW, replaces splats)
modulators: [ … ]     # signal → parameter routing            (NEW)
timeline:   [ … ]     # authored, time-anchored directives    (NEW)
diffusion:  { … }     # unchanged from v1
post:       { … }     # unchanged (minus aspect, moved to canvas)
prompts:    { … }     # unchanged
```

### 2.1 · Canvas

Output dimensions and orientation are first-class, chosen per project, not per recipe
constant:

```yaml
canvas:
  width: 1080          # output pixels
  height: 1920         # vertical 9:16 here; 1920x1080 for wide; 1024x1024 square
  fps: 30
  sim_resolution: 256  # simulation cells on the SHORT side; the long side scales
                       # with the aspect ratio, rounded to an FFT-friendly size
                       # (e.g. 256x448 grid for 9:16, not 256x455)
```

- The simulation grid becomes **rectangular** (see §3.1). All normalized coordinates
  (placement, regions) stay 0–1 per axis so recipes are aspect-independent.
- **FFT-friendly rounding:** the Poisson projection is an FFT, whose cost degrades
  badly on sizes with large prime factors (455 = 5·7·13). The long side is therefore
  rounded to the nearest size whose prime factors are only 2/3/5. The ≤ 2 % aspect
  error this introduces is absorbed by the existing sim-grid → output resize, which
  is non-uniform anyway.
- `post.aspect` is removed (subsumed). E4 chunking handles non-square via the model's
  supported buckets; if the model requires square, E4 letterboxes internally and
  E5 crops back (decision recorded per-model in the diffuser backend).
- UI presets: Square 1:1, Portrait 9:16, Landscape 16:9, plus free entry.

### 2.2 · Emitters

The single biggest change. The hardcoded kick/hat/lookahead trio becomes a **list of
emitters**, each fully described by four blocks: *trigger* (when), *placement* (where),
*color* (what color), *body* (physics). Any number of emitters; any number of
simultaneous live sources (this was already true in v1 — each onset spawned an
independent source — but now **count, position, and color are yours**).

```yaml
emitters:
  - id: kicks
    trigger:   { type: onset, band: low, min_mag: 0.0 }
    count: 1                      # sources spawned per trigger event
    placement:
      type: wander               # the v1 behavior, now explicit & tunable
      center: [0.5, 0.5]
      wander_amp: 0.16            # was hardcoded WANDER_AMP
      jitter: 0.09                # was hardcoded KICK_JITTER
    direction: { type: radial_out, jitter: 0.5 }   # was KICK_ANGLE_JITTER
    color:     { type: palette, palette: main, index: 0 }
    body:
      radius: 0.10
      force: 9000
      lifetime_s: 0.8
      emit: 0.22
      drift: 0.7
      speed: 1.3
      jet_fraction: 0.35          # was hardcoded JET_FRACTION
      decay: 1.3                  # was SOURCE_DECAY (emission envelope exponent)
      expand: 0.8                 # was SOURCE_EXPAND (radius growth over life)
      mag_gain: 1.0               # how much onset magnitude scales impulse/emit

  - id: hats
    trigger:   { type: onset, band: high, max_per_frame: 5 }
    placement: { type: random, region: [0.08, 0.08, 0.92, 0.92] }
    direction: { type: random }
    color:
      type: palette_cycle
      palette: main
      start: 1
      brightness: { source: centroid, range: [0.75, 1.25] }  # was hardcoded
    body: { radius: 0.03, force: 3500, lifetime_s: 0.3, emit: 0.11, drift: 0.3, speed: 2.6 }

  - id: melody                    # NEW capability: mids exist visually
    trigger:   { type: onset, band: mid }
    placement: { type: signal_x, source: chroma_argmax, range: [0.1, 0.9], y: 0.3 }  # pitch → x
    direction: { type: fixed, angle_deg: 90 }
    color:     { type: chroma_hue, saturation: 0.6, value: 0.9 }
    body: { radius: 0.05, force: 4000, lifetime_s: 0.6, emit: 0.15, drift: 0.5, speed: 1.8 }

  - id: pulse                     # NEW capability: the beat grid breathes
    trigger:   { type: beat, every: 4, min_mag: 0.3 }
    placement: { type: fixed, points: [[0.5, 0.5]] }
    direction: { type: radial_out, jitter: 0.0 }
    count: 8                      # a ring of 8 jets = a radial pulse
    color:     { type: palette, palette: main, index: 0, opacity: 0.4 }
    body: { radius: 0.18, force: 2000, lifetime_s: 0.4, emit: 0.05 }

  - id: tension                   # the v1 lookahead, now an ordinary emitter
    trigger:   { type: lookahead, section: drop, window_s: 8.0, every_frames: 3 }
    placement: { type: random, region: [0.2, 0.2, 0.8, 0.8] }
    color:     { type: palette, palette: main, index: 0, brightness: { value: 0.6 } }
    body: { radius: 0.08, force: 1500, emit: 0.10, lifetime_s: 0.7, drift: 0.6, speed: 0.8 }
```

**Trigger types**

| type | fires | params |
| --- | --- | --- |
| `onset` | on a detected onset | `band` (low/mid/high), `min_mag`, `max_per_frame` |
| `beat` | on the beat grid | `every` (1 = every beat, 4 = once a bar), `offset`, `min_mag` |
| `continuous` | every N frames while a condition holds | `every_frames`, `when` (e.g. `rms > 0.5`), `section` filter |
| `lookahead` | ramping before a section starts | `section` label, `window_s`, `every_frames` |
| `manual` | only from timeline directives (§2.4) | — |

**Placement types** (all coordinates normalized 0–1, aspect-independent)

| type | behavior | params |
| --- | --- | --- |
| `fixed` | explicit point list; `count` cycles through them | `points: [[x,y], …]` |
| `random` | seeded uniform in a region | `region: [x0,y0,x1,y1]` |
| `wander` | v1 kick behavior: jittered around a slowly orbiting anchor | `center`, `wander_amp`, `jitter`, `wander_freq` |
| `line` | `count` sources evenly spaced on a segment | `from: [x,y]`, `to: [x,y]` |
| `circle` | `count` sources on a circle/arc | `center`, `radius`, `arc_deg` |
| `grid` | `count` ≈ rows×cols lattice | `rows`, `cols`, `region` |
| `signal_x` / `signal_y` | one axis driven by an audio signal, the other fixed/random | `source` (any §1 signal), `range`, fixed `y`/`x` |

**Direction types:** `radial_out` (away from placement center), `radial_in`, `fixed`
(`angle_deg`), `random`, `flow` (along the local velocity field). All accept `jitter`
(radians of randomness).

**Color types**

| type | behavior |
| --- | --- |
| `fixed` | one hex color |
| `palette` | `palettes[palette][index]` |
| `palette_cycle` | cycles `palette[start:]` in order per spawn (v1 hat behavior) |
| `palette_random` | seeded random pick from the palette |
| `chroma_hue` | dominant pitch class → hue wheel (12 hues, rotatable via `hue_offset`), recipe sets `saturation`/`value` |
| `chroma_palette` | dominant pitch class → position across the active palette (interpolated) — pitch-driven color that stays inside the recipe's colors |
| `centroid_ramp` | spectral centroid → interpolation between two colors (`dark`, `bright`) |

Every color type accepts an optional `brightness` block (`{source: centroid|rms|fixed,
range|value}`) and `opacity`. The v1 "kicks own palette[0], hats cycle the rest,
centroid brightens hats" policy is now just the default recipe's choice, not a law.

### 2.3 · Modulators

Generic, declarative **signal → parameter** routing. This replaces (and generalizes)
the two hardwired couplings in v1 (RMS → vorticity, RMS → ambient amplitude):

```yaml
modulators:
  - source: rms                       # any §1 per-frame signal, or band.low/mid/high,
                                      # beat_phase, bar_phase, flux, harmonic_ratio,
                                      # section.energy, lookahead(drop, 8s)
    target: field.vorticity           # dot-path to any numeric recipe field
    range: [8, 38]                    # signal 0 → 8, signal 1 → 38
    mode: absolute                    # absolute | add | scale (see rules below)
    curve: linear                     # linear | pow(k) | smoothstep | step(threshold)
    smooth_s: 0.0                     # optional low-pass on the signal

  - source: rms
    target: field.ambient.strength
    range: [0.19, 1.6]                # = v1's AMBIENT_FLOOR semantics, now visible

  - source: band.low
    target: render.exposure           # NEW: the mix's bass weight breathes the image
    range: [1.8, 2.1]
    smooth_s: 0.3

  - source: beat_phase
    target: emitters.pulse.body.radius
    range: [0.14, 0.20]
    curve: pow(2)
```

Rules:
- Targets are validated against the recipe schema at load; unknown path = load error
  with the exact path in the message.
- **Modes** define how the mapped value combines with the base value (the recipe
  value after segment-override smoothing and timeline `set` windows):
  - `absolute` (default): the mapped value **replaces** the base — the modulator owns
    the target. A segment override on the same leaf is ineffective; validation flags
    it and suggests overriding the modulator's `range` per segment instead (segment
    overrides may target `modulators[i].range`).
  - `add`: base + mapped value (range is an offset, e.g. `[-5, +10]`).
  - `scale`: base × mapped value (range is a factor, e.g. `[0.8, 1.4]`) — the natural
    mode for "move around the per-segment base".
- Modulators targeting `emitters.*` write into the emitter **template**: sources
  sample it at spawn time and then follow their own envelope. Live sources are never
  retro-modulated (no mid-flight pops, no per-source bookkeeping).
- Modulatable targets: any numeric leaf under `field`, `render`, `emitters.*.body`,
  `emitters.*.color.brightness`. Structural fields (resolution, counts, types) are not
  modulatable.
- A target not covered by any modulator simply keeps its recipe value — silence in the
  config means "constant", never hidden behavior.

### 2.4 · Timeline

Authored, time-anchored directives — the "at 2 seconds I want 3 sources aligned
horizontally in the center" gesture. This is what the chat copilot mostly writes.

```yaml
timeline:
  - at: 2.0
    action: spawn
    emitter: kicks                    # reuse an emitter's color/body…
    count: 3
    placement: { type: line, from: [0.25, 0.5], to: [0.75, 0.5] }   # …override placement
    mag: 1.0                          # acts like a max-strength onset

  - at: 62.0
    action: spawn                     # fully inline one-off (no named emitter needed)
    count: 1
    placement: { type: fixed, points: [[0.5, 0.5]] }
    color: { type: fixed, hex: "#FFFFFF" }
    body: { radius: 0.25, force: 12000, lifetime_s: 1.5, emit: 0.4 }

  - between: [60.0, 75.0]             # parameter automation over a window
    action: set
    set: { field.vorticity: 34, render.bloom.amount: 0.9 }
    fade_s: 0.5                       # eased in/out at the window edges

  - at: 90.0
    action: mute                      # silence an emitter from here…
    emitter: hats
  - at: 105.0
    action: unmute                    # …to here
    emitter: hats
```

- `spawn` directives are injected into the same source list as audio-triggered ones —
  identical physics, fully deterministic.
- `set` windows sit **on top of** segment overrides and **under** modulators
  (precedence: recipe < segment override < timeline set < modulator).
- `at` / `between` accept absolute seconds **or musical anchors**, resolved against
  the score at load: `"section:drop"`, `"section:drop+4.0"`, `"beat:32"`, `"bar:8"`.
  Anchors are what make recipe-shipped timelines reusable — "a white flash on every
  drop start" adapts to any track. The UI shows directives as draggable pins on the
  waveform and writes whichever form the user authored (drag = seconds).
- Timeline lives in **`project.json`** (it is authored per-track), not in the recipe —
  but a recipe may ship `timeline` entries as defaults (merged, project wins),
  typically anchor-based so they adapt to the track's structure.

### 2.5 · Field & render

All v1 hardcoded constants move into the recipe with their current values as defaults:

```yaml
field:
  dissipation: 0.90
  velocity_dissipation: 0.96
  viscosity: 0.0
  vorticity: 8.0                  # base value; modulators move it (v1: min/max+rms)
  vorticity_gain: 0.015           # was VORT_K
  force_gain: 0.04                # was FORCE_K
  ambient:
    strength: 1.6                 # base; the RMS coupling is now a default modulator
    scale: 2.6
    speed: 0.16
  density_clamp: 12.0

render:
  exposure: 1.9
  bloom: { amount: 0.65, threshold: 0.45, sigma: auto }   # threshold was BLOOM_THRESHOLD
  background: 0.04
  gamma: 1.15

palettes:
  main: ["#B84A74", "#34808A", "#E0A458", "#6C4A8C", "#3FA39B", "#D98A5E"]
  accents: ["#FFFFFF", "#FFD27D"]
```

`vorticity: {min, max, driver}` is removed (expressed as a modulator). `splats:` is
removed (expressed as emitters). The vestigial `placement: anchored|scatter` and
`driver: rms` enums die with them.

### 2.6 · Migration

`load_recipe` detects `version` (absent = v1) and **upgrades v1 → v2 in memory**,
producing exactly the current behavior:

- `splats.low` → the `kicks` emitter (trigger onset/low, placement wander, color
  palette index 0, body from splat fields + the old constants).
- `splats.high` → the `hats` emitter (trigger onset/high with `max_per_frame`,
  placement random, color palette_cycle start 1 with centroid brightness).
- `vorticity {min,max}` → `field.vorticity: min` + a `rms → field.vorticity
  [min,max]` modulator.
- `lookahead_s` → the `tension` emitter.
- ambient RMS coupling → an `rms → field.ambient.strength [0.12·s, s]` modulator.
- `post.aspect` → canvas presets (square → 1024², wide → 1920×1080).

A golden test renders N frames of a v1 recipe through the upgrader and asserts
pixel-identical output against the v1 engine (same seed). The repo's `recipes/*.yaml`
are rewritten to v2 once the upgrader passes.

---

## 3 · Engine changes

### 3.1 Rectangular grid

`FluidSim` becomes H×W instead of N×N. The FFT Poisson projection generalizes directly
(per-axis eigenvalues); MacCormack advection and curl noise already operate on arrays
and need only shape plumbing. Normalized coordinates map per-axis. Velocity `.npy`
and control signals (E3) inherit the shape; `post.assemble` drops its aspect cropping.

### 3.2 Emitter/modulator runtime

`simulate()`'s hardcoded kick/hat/lookahead blocks are replaced by:

- **TriggerIndex** — precomputes, per frame, which emitters fire with what magnitude
  (from score events, beat grid, lookahead windows, timeline spawns).
- **Placer / Colorizer** — pure functions `(emitter, event, rng, frame_signals) →
  [(x, y, angle, color), …]` implementing §2.2 tables. Seeded from
  `recipe.seed + hash(emitter.id)` so adding an emitter never reshuffles another's
  randomness (critical for "change one thing, compare").
- **ModulationEngine** — resolves dot-paths once at load into fast setters; per frame
  evaluates `signal → curve → range` and writes into the effective config *after*
  segment smoothing.
- `_Source` itself is unchanged (it already supports arbitrary position, color,
  direction, lifetime) — v2 is about who spawns it, where, and in what color.

### 3.3 Determinism contract

Unchanged and strengthened: (seed, score, recipe, project) → bit-identical frames.
Per-emitter RNG streams (above) plus the existing global stream for ambient phase.

---

## 4 · Studio v2 — live parameter loop

The studio becomes a **three-pane instrument**: hear it, see it, turn a knob.

```
┌─────────────────────────────────────────────────────────────┐
│ ┌──────────────────────────────┐  ┌───────────────────────┐ │
│ │  PREVIEW (canvas aspect)     │  │ INSPECTOR (tabs)      │ │
│ │  loops current window        │  │ Canvas | Field |      │ │
│ │  ▶ ⏸ scrub                  │  │ Emitters | Modulators │ │
│ └──────────────────────────────┘  │ | Render | YAML       │ │
│ ┌──────────────────────────────┐  │                       │ │
│ │ WAVEFORM + LANES             │  │ (sliders, pickers,    │ │
│ │ audio | rms | bands | onsets │  │  per-emitter cards)   │ │
│ │ beats | sections | timeline📍│  │                       │ │
│ └──────────────────────────────┘  └───────────────────────┘ │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ CHAT  "at 2s, 3 sources aligned horizontally…"      [⏎] │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 4.1 The live loop

The iteration gesture: **edit a parameter → see the same few seconds re-rendered in
~1–3 s.**

- The preview always shows a **window** (default 6 s) around the playhead, simulated
  at draft resolution (existing `DRAFT_SIM_RES` machinery + `render_range` +
  warm-up).
- Any inspector/chat/YAML edit marks the recipe dirty; a debounce (400 ms) triggers
  `POST /preview_window {t0, t1, draft: true}`; the player swaps the clip when ready
  and keeps looping the window. Stale in-flight previews are cancelled server-side
  (one preview job per project, newest wins).
- **State checkpoints** make scrubbing affordable: the first full draft pass stores
  the sim state (u, v, density, source list, RNG states) every ~5 s into
  `runs/<id>/checkpoints/`. A window preview warms up from the nearest checkpoint
  ≤ t0 instead of cold-starting, so previewing at 2:30 doesn't simulate 150 s.
  Checkpoint staleness policy: a *structural* change (resolution, canvas, emitter
  list shape) invalidates all checkpoints. A plain numeric edit keeps them for the
  immediate preview — latency wins; warm-up absorbs most of the drift — but marks
  them **stale**, and an idle background pass re-simulates and refreshes them so
  drift never accumulates across edits. HQ window renders and final renders never
  read checkpoints, so the delivered clip is always exact; the accepted tradeoff is
  that a draft preview right after an edit may differ slightly from a from-scratch
  state until the refresh lands.
- Draft is the default; a "HQ window" button renders the window at full resolution.

### 4.2 Waveform lanes

Under the audio waveform, toggleable lanes render score signals so you can *see* what
drives what: RMS, band split (stacked area), onsets per band (tick marks), beat grid,
sections (colored spans, editable as today), and timeline pins (draggable; double-click
opens the directive editor). Hovering an emitter card in the inspector highlights the
lane that triggers it.

### 4.3 Inspector

- **Canvas tab:** orientation presets + width/height/fps/sim_resolution. Changing
  canvas invalidates checkpoints and (if fps changes) triggers re-analysis.
- **Emitters tab:** one card per emitter — enable/mute, trigger, placement (with a
  mini 2D pad to drag points/regions directly on a thumbnail of the canvas), color,
  body sliders. "Add emitter" from templates (kick jet, scatter pops, pitch line,
  beat pulse, tension).
- **Modulators tab:** rows of `source → target` with range/curve; targets picked from
  a searchable tree of valid paths.
- **YAML tab:** the full recipe + project timeline, two-way synced with the form
  (single source of truth = the server-side document; both views patch it).
- Every numeric control shows its default and a reset affordance; an "audio-driven"
  badge appears on any field currently targeted by a modulator.

---

## 5 · Chat copilot

A chat panel whose assistant edits the project **only through typed tools** — the same
validated mutation endpoints the UI uses. No code execution, no file access.

### 5.1 Architecture

- Backend endpoint `POST /api/projects/{id}/chat` (server-sent events for streaming).
  The server holds the conversation, calls the LLM, executes tool calls, streams
  text + applied changes back.
- **The model is swappable.** The server defines one internal interface —
  `complete(messages, tools) → (text deltas, tool calls)` — with a backend per
  provider. v2 ships two: **Anthropic (Claude)** and **Google (Gemini)**, both of
  which support JSON-schema tool calling natively. Provider, model name, and API key
  are chosen in Settings (keys live server-side, never sent to the browser).
  Everything below the interface — tools, validation, revisions, system prompt — is
  provider-neutral, so adding a third backend (e.g. any OpenAI-compatible endpoint)
  touches one module.
- The system prompt embeds: the recipe v2 schema (with ranges and effects of each
  field), the current project/recipe JSON, and a compact score digest (duration,
  tempo, sections, onset density per band) so "the drop" or "around 2 seconds"
  resolves to real times and segments.

### 5.2 Tools

| tool | effect |
| --- | --- |
| `get_project()` | current recipe + segments + timeline (refreshes context) |
| `get_score_summary(t0?, t1?)` | sections, beats, onset counts, energy in a window |
| `patch_recipe(ops)` | JSON-patch list against the recipe; schema-validated, returns errors verbatim |
| `add_emitter(spec)` / `update_emitter(id, patch)` / `remove_emitter(id)` | emitter CRUD |
| `add_modulator(spec)` / `remove_modulator(index)` | routing CRUD |
| `add_timeline_directive(spec)` / `update/remove` | the "at 2s…" gesture |
| `update_segment(index, patch)` | per-section overrides & prompts |
| `set_canvas(spec)` | dimensions/orientation |
| `preview(t0, t1)` | trigger a draft window preview at the relevant moment |

Example — *"at 2 seconds, I expect a bigger visual: 3 sources aligned horizontally in
the center"* →

```json
add_timeline_directive({
  "at": 2.0, "action": "spawn", "emitter": "kicks", "count": 3, "mag": 1.0,
  "placement": {"type": "line", "from": [0.3, 0.5], "to": [0.7, 0.5]}
})
preview(0.5, 5.0)
```

### 5.3 Safety & ergonomics

- Every mutation goes through schema validation; the model receives validation errors
  and self-corrects. Nothing invalid can reach the engine.
- Each chat turn that mutates state creates one **revision** (see §6 undo); the chat
  message shows a human-readable diff chip ("+ timeline spawn @2.0s · 3 sources, line
  center") with an undo button.
- The assistant is instructed to follow each visible change with `preview()` so the
  user *sees* the answer, and to ask rather than guess when a request is ambiguous
  (e.g. "bigger visual" → radius vs count vs force).

---

## 6 · API changes

New/changed endpoints (existing ones keep working):

| endpoint | purpose |
| --- | --- |
| `GET /api/projects/{id}/signals?lanes=rms,bands,onsets,beats&px=2000` | downsampled lane data for the waveform |
| `PATCH /api/projects/{id}/recipe` | JSON-patch with schema validation (shared by UI + chat tools) |
| `PATCH /api/projects/{id}/timeline` | timeline directive CRUD |
| `POST /api/projects/{id}/preview_window` | `{t0, t1, draft}` → job; supersedes `preview_segment` (kept as alias); uses checkpoints |
| `GET /api/projects/{id}/revisions` · `POST …/revisions/{n}/restore` | undo history: every mutation appends `project.json` to a revision log inside the run dir |
| `POST /api/projects/{id}/chat` (SSE) | the copilot |
| `GET/PUT /api/settings` | LLM provider + model + API keys, GPU provisioning keys |

Schema validation: recipe v2 gets a JSON Schema (generated from the dataclasses)
served at `GET /api/schema/recipe`, used by the server (authoritative), the YAML tab
(inline diagnostics), and embedded in the chat system prompt.

---

## 7 · Milestones

Ordered so each lands something usable; engine before UI before chat.

**V2-M1 — Recipe v2 engine.** Score v2 signals; emitter/modulator/timeline runtime;
constants exposed; v1 upgrader + golden pixel test; recipes in repo rewritten to v2.
*done: the default v2 recipe reproduces v1 output bit-for-bit; a demo recipe uses mids,
beats, chroma color, and a line placement.*

**V2-M2 — Canvas.** Rectangular grid through E2→E3→E5; canvas block; UI preset picker.
*done: the same recipe renders 9:16, 16:9 and 1:1 from one project.*

**V2-M3 — Live studio.** Three-pane layout, waveform lanes, inspector forms ↔ YAML
sync, window preview with debounce + checkpoints.
*done: slider drag → updated looping preview in ≤ 3 s on a 3-min track, anywhere on the
timeline.*

**V2-M4 — Chat copilot.** Chat endpoint, tools, revisions/undo, diff chips.
*done: the "3 sources aligned at 2s" sentence produces the directive, a preview, and an
undoable revision — without touching the inspector.*

**V2-M5 — Default recipe polish.** A v2 default that actually uses the new signals
tastefully (mids, beat pulse, chroma accents) and 2–3 showcase recipes.
*open-ended, the garden part.*

---

## 8 · Risks & open questions

| risk | severity | mitigation |
| --- | --- | --- |
| v2 recipe schema too expressive → overwhelming UI | medium | inspector shows templates + the few fields that matter; full power lives in YAML/chat; defaults everywhere |
| pixel-golden migration test brittle across numpy/cv2 versions | low | pin versions in CI; tolerance fallback (max abs diff ≤ 1 LSB) |
| checkpoint files large (256² × ~40 floats × every 5 s) | low | ~1–2 MB each, fp16 storage; cap + LRU per run |
| chat edits that "work" but look bad | medium | every chat mutation auto-previews; one-click undo; revisions |
| non-square breaks the diffusion model's sweet spot | medium | per-backend bucket table; letterbox fallback recorded in the manifest |
| modulator spaghetti (many routes, hard to debug) | medium | "audio-driven" badges on fields; a modulator inspector lane showing the evaluated signal over the waveform |

**Open questions**

- **Streaming previews**: MP4 swap is simple; if 1–3 s still feels laggy, upgrade path
  is WebSocket frame streaming into a canvas while the encode finishes.

**Resolved during review**

- **LLM provider**: swappable by design — a single internal completion/tool-call
  interface with per-provider backends; Claude and Gemini ship in v2, provider +
  model selected in Settings. See §5.1.
- **Modulators on emitters** modulate the *template* only — sources sample it at
  spawn, then follow their own envelope (physical coherence, no mid-flight pops, no
  per-source bookkeeping). See §2.3.
- **Chroma color**: both a rotatable hue wheel (`chroma_hue` + `hue_offset`) and a
  palette-constrained variant (`chroma_palette`) — pitch-driven color shouldn't have
  to fight the recipe's palette. See §2.2.
- **Timeline in project vs recipe**: project for absolute pins, plus musical anchors
  (`section:drop+4.0`, `beat:32`) so recipe-shipped timelines adapt to any track.
  See §2.4.

---

*kaika 開花 · spec v2.0 · the recipe describes everything; the studio shows everything;
the chat speaks both.*
