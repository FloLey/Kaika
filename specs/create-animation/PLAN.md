# Create Animation — Master Build Plan

A per-segment **node-graph editor** for Kaika. Signals, constants, and the fluid
simulation become draggable **cards** on a **playground**; you wire them together
and the graph renders to a looping **video** that reacts to the music.

This document is the entry point. It states the goal, the locked decisions, the
architecture, and an **ordered list of build steps** — one detailed spec per step
in this folder. Build them in order; each ends in a state you can run and verify.

---

## 1. Goal

Add a second mode to the per-segment workspace:

- **Extract signals by track** — the existing Studio (unchanged).
- **Create animation** *(new)* — a drag-and-drop canvas where:
  - **Signal cards** expose a segment's signals (the 0..1 "pulses").
  - **Constant cards** are sliders that emit a fixed value.
  - A **Fluid artifact card** exposes its parameters as **input ports**; each port
    can be fed by a constant or a signal.
  - An **Output card** shows the rendered looping video.

A signal wired into a parameter **animates that parameter over the clip** (its
0..1 curve maps into a `[lo, hi]` range set on the connection, frame by frame).

The architecture must be **extensible**: later building blocks (combine signals,
combine outputs, more artifacts) drop in as new node types without reworking the
canvas, the executor, or persistence.

---

## 2. Locked decisions

| Decision | Choice | Consequence |
|---|---|---|
| Canvas | **Hand-built** (SVG + pointer events) | No node-graph dependency; we own pan/zoom/ports/edges. See `05-canvas.md`. |
| v1 scope | **Vertical slice**: Signal + Constant → Fluid → Output, per segment | Combine / multi-artifact nodes deferred, but the model reserves room. |
| Modulation | **Animate over the clip** (per-frame) | Fluid sim must accept time-varying params. See `02-fluid-time-varying.md`. |

---

## 3. Architecture summary

### Value flow

```
 [Signal card] --curve(0..1)--\                          per-frame arrays
 [Constant card] --value-------> [Fluid card input ports] -----> simulate() --> mp4 --> [Output card]
                                  (each port: const | signal,        ^
                                   signal carries [lo,hi] range)      |
                                                              backend graph executor
```

- A **value source** (signal or constant) produces a stream. A constant is a flat
  line; a signal is a 0..1 curve over the segment.
- Every **edge into a fluid parameter** carries a range `[lo, hi]` (defaults to the
  param's native min/max). Per frame: `value = lo + (hi - lo) * source`.
  A constant collapses to a flat value (in native units); a signal animates.
- The **executor** resolves the graph → a `params` dict where each modulatable
  field is a scalar **or** a length-`nframes` array → `fluid.simulate()` →
  `render_mp4()` → cached mp4 URL.

### Where it lives

- **Graph data** is per segment: `segment.graph = { nodes, edges }` (or `null`).
  It persists for free through the existing autosave → `db.save_segments` JSONB
  document. No DB migration.
- **UI** is a tab inside the existing `step === "studio"` screen, switched by a
  **bottom bar**, sharing the `SegmentRail` and the active segment with the
  signal-extraction tab.

### Reused building blocks (do not reinvent)

| Need | Reuse | Path |
|---|---|---|
| Extract a signal's curve | `extract(...)` | `backend/signals.py` |
| Run the sim → frames | `simulate(params)` | `backend/fluid.py` |
| Encode frames → mp4 | `render_mp4`, `params_hash` | `backend/fluid.py` |
| Per-segment persistence | `save_segments` (whole JSONB tree) | `backend/db.py` |
| Autosave loop | segments effect | `frontend/src/App.jsx` |
| Signal shape + serialize/hydrate | `segments.js` | `frontend/src/lib/segments.js` |
| Slider / toggle / help controls | `Ctl`, `Toggle`, `Info` | `frontend/src/ui/` |
| Theme tokens | `--papier/--panel/--line/--text/--petale/--courant/--shadow/--mono` | `frontend/src/styles/base.css` |

---

## 4. Core principle — every step is independently testable

No step depends on a later step to be verifiable. Each spec carries a
**two-audience verification**:

- **Agent check** — automatable: a `pytest`/`vitest` case, a `curl`/python snippet
  against a hand-written fixture, or `npm run build`/`lint`. Must pass *before*
  later steps exist.
- **User check** — manual: a command to run, a screen to open, what to click, and
  the expected result.

Each spec names the **fixture/seed data** (sample graph JSON, a known
`job_id`/segment) so a failure points at one step, not the whole feature.

The backend chain (`02 → 03`) is fully exercisable with a hand-authored graph
JSON + `curl` **before any frontend exists**. Each frontend step is visible in the
running app (`make dev`): canvas renders → nodes drop → wires connect → Render
produces a looping video.

---

## 5. Build steps (one spec each)

Build top-to-bottom. The two backend steps can land and ship first; the frontend
chain follows; styling rides alongside the UI; tests/docs close it out.

| # | Spec | Delivers | Depends on |
|---|---|---|---|
| 01 | [`01-data-model.md`](./01-data-model.md) | Graph data model, persistence contract, fluid param spec (shared source of truth) | — |
| 02 | [`02-fluid-time-varying.md`](./02-fluid-time-varying.md) | Backend: `simulate()` accepts per-frame params (backward compatible) | 01 |
| 03 | [`03-graph-executor-api.md`](./03-graph-executor-api.md) | Backend: `graph.py` executor + `/animate` route + caching | 01, 02 |
| 04 | [`04-frontend-graph-lib.md`](./04-frontend-graph-lib.md) | Frontend: `graphModel.js`, `fluidParams.js`, segments serialize/hydrate, `api.renderGraph` | 01 |
| 05 | [`05-canvas.md`](./05-canvas.md) | Frontend: hand-built pan/zoom/ports/edges canvas (node-type-agnostic) | 04 |
| 06 | [`06-nodes.md`](./06-nodes.md) | Frontend: the four node cards + palette | 04, 05 |
| 07 | [`07-workspace-integration.md`](./07-workspace-integration.md) | Frontend: bottom-bar mode switch, graph state, Render flow → Output | 03, 06 |
| 08 | [`08-styling.md`](./08-styling.md) | `styles/animation.css` in the Kaika theme | 06, 07 |
| 09 | [`09-tests-docs-verification.md`](./09-tests-docs-verification.md) | Unit tests, in-app Docs section, end-to-end checklist | all |

**Dependency order:** 01 underpins everything · 02→03 is the backend chain ·
04→05→06→07 is the frontend chain · 03+07 close the end-to-end loop · 08 alongside
06/07 · 09 last.

### Suggested milestones (each independently demoable)

- **M1 — Backend renders a graph (no UI).** Steps 01–03. Demo: `curl` a
  hand-written graph JSON at `/animate`, get back a looping mp4 whose `force`
  visibly pulses with a drum signal.
- **M2 — Canvas you can play with.** Steps 04–06. Demo: open the animation tab,
  drop nodes, drag them, wire ports — no render yet.
- **M3 — Full loop.** Step 07. Demo: wire signals → press Render → looping video in
  the Output card, persisted across reload.
- **M4 — Polished + documented.** Steps 08–09.

---

## 6. v1 boundary & extension points

**In v1:** node types `signal`, `constant`, `fluid`, `output`; one fluid + one
output per graph; explicit Render button; sync render + hash cache.

**Explicitly deferred (but designed for):**
- `combine` nodes (mix/multiply/max two signals) — a new node type with 2 inputs +
  1 output; the executor resolves it before it reaches a param. The data model
  (`01`) and executor (`03`) must not assume a value source is *only* a signal or
  constant.
- Multiple artifacts / chaining outputs — the executor walks a DAG, not a fixed
  3-stage pipeline; keep resolution generic (resolve a node by id, memoized).
- More artifacts beyond fluid — the **param spec** pattern (`01`/`04`) generalizes;
  a new artifact ships a spec + a `simulate`-like function + an executor branch.

Each spec calls out where it must stay generic to keep these cheap later.

---

## 7. Global acceptance criteria

- A user can, within a segment, switch to **Create animation**, drop a Fluid card
  and an Output card, wire one or more signal/constant cards into fluid params
  (setting `[lo,hi]` on signal wires), press **Render**, and see a looping video in
  which the wired parameters visibly track the music.
- The graph **persists** across reload (autosave) and is **scoped per segment**.
- Identical graphs render instantly (hash cache); FluidLab and the rest of the app
  are unaffected (scalar fluid path untouched).
- `npm run build`, `npm run lint`, `npm run test` (frontend) and `pytest` (backend)
  are green.
- Every step was verifiable on its own per its spec's two-audience checks.
