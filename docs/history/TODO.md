# TODO

Signals support 8 feature types (`signals.py` `_RAW`): energy, onset, flux,
brightness, harmonic, chroma, beat, bar — each with full shaping (attack/release/
invert/gamma/gain/offset/threshold), drawn live + pulse-pad preview per segment,
persisted to Postgres.

## Signal features — DONE
- [x] onset, flux, brightness, harmonic, chroma, beat/bar phase + feature selector.

## Simulation (rebuild Kaika ON TOP of this project — later, big milestone)
The signals are NOT exported to the external Kaika. The visual simulation will be
rebuilt inside this project and read the per-segment signals directly (from
Postgres / in memory). No disk export / hand-off needed.
- [x] First fluid sim: standalone **fluid lab** — backend `fluid.py` (Stam
      stable-fluids, ported from Kaika) computes a centered-source clip, looped
      live in the UI with debounced controls (`/fluid` + `FluidLab.jsx`).
- [ ] Design the in-project sim that consumes a segment's signals (curves) as
      per-frame control inputs.
- [ ] Decide the contract the sim reads (fps, normalization 0..1, signal naming).
- [ ] A timeline/preview that plays a segment with its signals driving visuals
      (the pulse pad is the first seed of this).

## Kaika fluid sources — signal-driven (next big step, after the sim above)
The idea: model a *fluid source* as a first-class object in Kaika and let signals
drive its behaviour live.
- [ ] Define all the characteristics of a fluid **source** in Kaika (its full set
      of inputs/parameters — e.g. position, rate/flow, velocity, density, pressure,
      temperature, viscosity, color, lifetime, spread/angle… enumerate the complete
      schema).
- [ ] Build a "patching" stage where you can link a pulse/signal to any one input
      of a source object and watch how it changes the source's behaviour.
- [ ] Wiring: connect each signal (output) to a source input and see, in a live
      render, what changes in the fluid as the connection drives it.
- [ ] Support multiple fluids at once — each with its own source + its own
      signal→input wiring — composed in the same live render.

## Shaping / combination extras
- [ ] Combine signals: multiply / mix / max two signals.
- [ ] Derivative shaper (react to change) and accumulator/build shaper.
- [ ] Per-signal output range remap (min→max), quantize/steps.

## Card builder — generate new cards from a description (idea, not scheduled)
Let the user describe a card in three fields — **input**, **output**, and **what
it does** — and have the app author the card, register it, and make it usable
immediately, without a manual code change per card. The end state: a single
"registry of tools" that both *describes* every card and *implements* it, so cards
can be loaded dynamically and new ones added on the fly.
- [ ] UI: a "new card" form with the three fields (input schema / output schema /
      behaviour description) — probably a new palette entry or Studio panel.
- [ ] Codegen: turn the description into a real card = the surfaces adding a card
      touches today, so a generator has to produce all of them in lockstep:
      frontend `nodes/registry.ts` entry + a `*Node` component + a `graphModel`
      factory; backend param spec (`animation_params.py`) + whole-clip *and*
      block-streaming render handlers (`graph_render.py`); a Playground pipeline
      (`card_demo.py` `CARD_LABELS` + re-export); and docs/help (`paramHelp.ts` /
      `Docs.tsx` section). See DEVELOPMENT.md "Checklist — add a node type".
- [ ] Dynamic loading: a place where all cards are described + implemented so they
      can be loaded at runtime and new ones appended — decide static-file codegen
      (write files + reload) vs. a true runtime plugin registry, and how generated
      cards stay compatible with `RENDER_VERSION` / `GRAPH_VERSION` + the codegen
      contract that keeps backend specs the source of truth.
- [ ] Safety: generated card code runs in the render pipeline — sandbox/validate
      it (schema-check the param spec, lint/typecheck before it goes live, guard
      the render handlers against bad output).

## Cleanup — DONE
- [x] Removed dead `TrackRow.jsx`, `FreqControls.jsx`, `Modal.jsx` + their CSS.
