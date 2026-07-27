# TODO

> **⚠ SUPERSEDED — kept as history, not as work.**
>
> Every unchecked box below shipped long ago, delivered by the node graph rather than by
> the features this file imagined: the in-project sim design, the signal contract, the
> combine multiply/mix/max modes, the derivative shaper and per-signal range remap all
> exist as the `math`, `change` and `combine` cards and `[lo,hi]` bindings. The boxes were
> never ticked, so anyone skimming this read shipped work as open work — which cleanup
> step 14 asked to fix and nobody did. Do not treat any line here as a task.


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

## Cleanup — DONE
- [x] Removed dead `TrackRow.jsx`, `FreqControls.jsx`, `Modal.jsx` + their CSS.
