# 01 — Signal / modulator cards (`value`)

> Today the **only** `value` source in the graph is a **signal** card (a read-only
> mirror of a studio signal). You can't combine two signals, generate motion without
> audio, or re-shape one signal differently per port — every modulation choice has to
> be baked in the studio. These four cards make `value` a first-class, composable
> layer: **Math/Blend** (combine signals), **LFO/Oscillator** and **Noise**
> (generate), **Shaper/Remap** (re-curve). They are the cheapest cards to build (no
> new render path — just a 0–1 array per frame) and the highest-leverage, because
> every fluid/FX/source param already modulates against `value`.

## Locked decisions

1. **New palette category `modulators`.** `signal` stays under `sources`; these four
   go in a new `modulators` group (added to `PaletteCategory` /
   `PALETTE_CATEGORIES` in `registry.ts`). Menu order after `sources`, before
   `generators`.
2. **Value→value uses plain edges, not bindings** (PLAN P1). The `lo/hi` mapping lives
   only at the fluid-param boundary; intermediate value cards pass the 0–1 curve
   through unchanged. Input ports are named (`a`/`b` for Math, `in` for Shaper).
3. **`resolve_source` becomes recursive** (PLAN P1). A value card resolves its inputs
   via `resolve_source`, memoised by the existing `cache` dict; acyclicity is already
   guaranteed by `validate`'s `hasCycle`. No executor reordering.
4. **Generators are tempo-aware.** LFO/Sequencer rate can be expressed in beats and
   resolved against the segment tempo, reusing the phase math behind
   `signals.raw_beat` / `signals.raw_bar` rather than re-deriving BPM.
5. **Shaper reuses `signals.shape()` verbatim** — the same fixed order
   (invert → follower → threshold → gamma → gain/offset → clamp) as the studio, so a
   Shaper'd signal reads identically to a studio-shaped one.
6. **All four output a single `out` port, flow `value`.** Curves are always length
   `nframes` (= `round(duration * fps)`), clamped to 0–1.

## Architecture this builds on

- Frontend: `registry.ts` (`NODE_TYPES`, `PaletteCategory`), `frontend/src/lib/types.ts`
  (`GraphNode` union, `PortFlow`, `Binding`), `frontend/src/lib/graphModel.ts`
  (`mkNodeId`, factories, `normalizeGraph`, the generic `connectVideo` edge writer to
  reuse for value→value), `nodes/NodeFrame.tsx` (`Port`), `ports.ts`
  (`connectIssue`/`canConnect` — `value` flow already matches).
- Existing model: `SignalNode.tsx` (read-only `value` source with a sparkline) is the
  closest template for a value card's chrome.
- Backend: `graph.py` `build_params.resolve_source` (the dispatch to extend; currently
  `signal` only — `graph.py:444-454`), `_signal_curve` (how `signal` resolves to a
  curve), `signals.py` `shape()` / `_RAW` / `raw_beat` / `raw_bar`.
- `nframes` is fixed by the executor (`build_params`, `graph.py:439`) — cards never set
  duration.

## Cards

### A1 — Math / Blend  (`id: math`)
1. **Purpose.** Combine 2+ value inputs into one. e.g. gate vocal energy by the beat
   (`energy × beat`), or floor a kick under an LFO (`max(kick, lfo)`).
2. **Ports.** Inputs `a`, `b` (flow `value`, plain edges; `+ input` adds `c`, `d`…).
   Output `out` (`value`).
3. **Static params.** `op`: `add | multiply | max | min | subtract | mix`. `mix`
   amount (0–1, default 0.5) — only shown for `op = mix` (crossfade `a→b`); modulatable
   (a `value` port via P2) so the blend itself can be automated.
4. **Frontend.** `MathData { op; inputs: string[]; mix: { binding } }`; factory seeds
   two inputs + `op:"multiply"`. Component: an op `<select>` + per-input rows with an
   `in` Port each. `normalizeGraph` ensures ≥2 inputs and a valid `op`.
5. **Backend.** `resolve_source` branch: resolve each wired input to a curve, fold with
   the op (numpy elementwise), clamp 0–1. Unwired inputs resolve to 0 (the existing
   `np.zeros(nframes)` default). `mix` resolves via P2.
6. **Docs.** `animation-math` — "Blend two signals: multiply to gate, max to floor, mix
   to crossfade."

### A2 — LFO / Oscillator  (`id: lfo`)
1. **Purpose.** A value with no audio input — sine/tri/saw/square at a tempo-locked or
   free rate. Idle drift, steady pulsing, slow colour sweeps.
2. **Ports.** No input. Output `out` (`value`).
3. **Static params.** `shape`: `sine | triangle | saw | square`. `rate_mode`:
   `beats | hz`. `rate` (beats: e.g. ×1, ÷2 of a beat; hz: 0.05–8). `phase` (0–1).
   `duty` (square only). Optional modulatable `rate` (P2) for accel/decel sweeps.
4. **Frontend.** `LfoData { shape; rateMode; rate; phase; duty }`. Component: shape
   `<select>`, rate control, phase slider; a small live preview reuses `SignalNode`'s
   sparkline (`CurveView`).
5. **Backend.** `resolve_source` branch: build `t = arange(nframes)/fps`; for
   `beats` mode convert `rate` to Hz via the segment tempo (same BPM source as
   `raw_beat`/`raw_bar`); evaluate the waveform to 0–1.
6. **Docs.** `animation-lfo` — "Generate motion with no audio: a sine/saw that pulses
   on the beat or at a fixed rate."

### A3 — Noise  (`id: noise`)
1. **Purpose.** Smooth, non-repeating 0–1 wander. Organic variation where an LFO would
   feel mechanical (drifting position, breathing radius).
2. **Ports.** No input. Output `out` (`value`).
3. **Static params.** `rate` (0.05–8, change speed). `seed` (int — deterministic, so
   renders are cache-stable). `octaves` (1–4, fractal detail).
4. **Frontend.** `NoiseData { rate; seed; octaves }`; sparkline preview.
5. **Backend.** `resolve_source` branch: value-noise from a seeded `np.random.default_rng(seed)`
   — generate control points at `rate`, interpolate (smoothstep) to `nframes`, sum
   octaves, normalise to 0–1. **Determinism note:** seed it from `seed` only (never
   wall-clock) so the render-cache hash stays stable.
6. **Docs.** `animation-noise` — "Organic random drift; set a seed so it renders the
   same each time."

### A4 — Shaper / Remap  (`id: shaper`)
1. **Purpose.** Re-curve **one** value per use — reuse a single studio signal three
   ways (sharp on one port, soft on another) without editing the studio or duplicating
   signals.
2. **Ports.** Input `in` (`value`, plain edge). Output `out` (`value`).
3. **Static params.** The studio shaping knobs, same ranges as `Signal` in
   `types.ts` / `signals.shape()`: `attack`, `release`, `invert`, `threshold`,
   `gamma`, `gain`, `offset`, plus a `[lo, hi]` output remap. Any can be modulatable
   (P2) — e.g. an LFO sweeping `gamma`.
4. **Frontend.** `ShaperData { attack; release; invert; threshold; gamma; gain; offset; lo; hi }`;
   reuse the studio shaping controls (mirror `SignalCard`'s shaping section).
5. **Backend.** `resolve_source` branch: resolve `in`, call `signals.shape(curve, ...)`
   with the card's knobs (at the executor `fps`), then apply the `[lo,hi]` remap and
   clamp. **No new shaping math** — `shape()` is the authority.
6. **Docs.** `animation-shaper` — "Re-shape one signal per port: sharpen, soften,
   invert, or remap its range without touching the studio."

## Open questions (resolve while drafting)

- **value→value chaining depth.** Confirm `resolve_source` recursion + `cache` is
  sufficient (it should be — it mirrors `_Dag.video`). Add a test: `signal → shaper →
  math → fluid.emit` renders and the cache resolves each node once.
- **Tempo source at render time.** Verify the segment/job exposes BPM to the executor
  the way `raw_beat`/`raw_bar` get it; if not, thread it through `build_params` once
  and share with LFO/Sequencer.
- **Palette grouping.** Confirm `modulators` reads well in the menu, or fold these
  under `sources` if a fifth group feels heavy.

## Verification

- One-card renders: `lfo → fluid.angle`, `noise → fluid.radius`, `signal → shaper →
  fluid.emit`, `(signalA, signalB) → math(multiply) → fluid.emit` each produce an mp4.
- `normalizeGraph` upgrades a v2 save containing each card unchanged; `validate`
  accepts the value→value edges and still rejects cycles.
- Determinism: re-rendering a Noise graph twice hits the render cache (same
  `output_hash`).
