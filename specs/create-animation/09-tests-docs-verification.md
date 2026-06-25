# 09 — Tests, docs & end-to-end verification

> Lock in the feature with automated tests, the in-app guide section, and a full
> manual checklist. Closes **Milestone M4**.

## Goal

Make the feature regression-proof and discoverable: unit tests for the graph model
and executor, a parity test between the frontend/backend param specs, an in-app
Docs section (reachable from the `?`), and a written end-to-end acceptance run.

## Files

- **Create** `tests/test_graph.py` — backend executor + validation tests.
- **Create/extend** `frontend/src/__tests__/graphModel.test.js` — model tests.
- **Modify** `frontend/src/components/Docs.jsx` — add an "animation" section.
- **Modify** `backend/animation_params.py` (or wherever the spec lives) — ensure it
  exports keys for the parity test.
- *(Optionally a `data/` cleanup note for accumulated animation mp4s.)*

## Design detail

### Backend tests (`tests/test_graph.py`)

Follow the existing `tests/test_signals.py` style (`from backend.signals import …`).

- `test_validate_rejects_missing_output` — a graph with no output node → `validate`
  raises / returns not-ok.
- `test_validate_rejects_dangling_binding` — a port bound to a non-existent nodeId.
- `test_render_constant_graph` — feed `graph-min.json` (with a small grid override
  for speed) through `graphmod.render` using a tiny synthetic stem; assert the
  output mp4 exists and is non-empty.
- `test_render_modulated_lengths` — assert that a signal-bound param becomes a
  per-frame array of length `nframes` (unit-test the param-building function in
  isolation, mocking `signals.extract` to return a known ramp). This proves the
  `lo + (hi-lo)*curve` mapping without needing real audio.
- `test_time_varying_fluid` — the `02` snippet as a real test: constant-array ≈
  scalar; ramped force renders.
- `test_cache_hit` — rendering the same graph twice yields the same path and
  doesn't recompute (e.g. patch `simulate` with a counter).

> Keep grids/durations tiny (e.g. grid 32, duration 1 s) so the suite stays fast.

### Frontend tests (`graphModel.test.js`)

- Factory shapes match `01`; fresh `fluidNode` has a `const` binding per param.
- `connect`→`disconnect` round-trips to a `const` binding with no leftover edge;
  invariant (binding↔edge) holds.
- `removeNode` removes edges and resets ports bound to it.
- `validate` matches the backend rules (missing/multiple output, dangling, cycle).
- `graphHash` stable under `x/y/view` changes; changes when a binding changes.
- `serializeSegments(hydrateSegments(seg)).graph` round-trips; a `signalNode`'s
  `signalId` still resolves to a hydrated signal (the `04` id-stability fix —
  preserves stored ids, Issue 2A).
- `splitAt` on a segment with a graph: the second half's signals get fresh ids AND
  its graph's `signalNode.signalId`s are remapped to those ids (no dangling refs);
  the two halves don't share a graph object.

### Param-spec parity test

A test (frontend vitest reading a JSON dump, or a backend test importing both via a
shared JSON) asserting `FLUID_PARAM_KEYS` (frontend) == `PARAMS` keys (backend) and
that min/max/def agree. Prevents silent drift that would mis-map ranges. Simplest:
emit the backend `PARAMS` to a committed `specs/create-animation/fixtures/params.json`
and have vitest assert equality against `fluidParams.js`.

### Docs section (`Docs.jsx`)

Add an **"animation"** section to the in-app guide (the component rendered at
`/?doc=<section>`), covering: what the playground is, the node types (signal,
constant, fluid, output), how to wire a signal into a parameter and set its
`lo/hi` range, the Render button, and that graphs are per-segment and autosaved.
Wire the bottom-bar "create animation" and the FluidNode/port `Info` `?` badges to
deep-link here (`section="animation"` on the relevant `Info`/help links), matching
the existing deep-link pattern (`App.jsx` help-link, `Ctl`/`Info` `section`).

## Reuse

- Test scaffolding — `tests/test_signals.py`, `frontend/src/__tests__/segments.test.js`.
- Docs structure + deep-link `section` convention — `Docs.jsx`, `ui/Info.jsx`,
  `App.jsx`.

## Acceptance criteria

- [ ] `pytest` green, including the new `test_graph.py`.
- [ ] `cd frontend && npm run test` green, including model + parity tests.
- [ ] `npm run build` + `npm run lint` + `ruff` green.
- [ ] The `?` from the animation tab opens the guide at the animation section.
- [ ] The end-to-end checklist below passes by hand.

## Verification (two-audience)

**Agent check:**
```bash
.venv/bin/python -m pytest tests/test_graph.py -q
cd frontend && npm run test && npm run lint && npm run build
.venv/bin/ruff check backend
```

**User check — full end-to-end acceptance run:**
1. `make dev`; upload a short track (or open an existing project); go to studio.
2. In the **signals** tab, confirm a couple of signals exist for the active segment.
3. Switch to **create animation**; add Fluid + Output; wire Fluid → Output.
4. Add a Signal (drums kick energy) → wire into **force** (`lo 0, hi 45`); add a
   Constant → wire into **vorticity**; press **Render**.
5. The Output shows a looping clip whose jet pulses with the kick and whose swirl
   reflects the constant. Adjust `lo/hi`, re-render, see the change.
6. Reload the project → the graph (nodes, wires, positions) is intact for that
   segment; a different segment has its own graph.
7. Open the `?` guide from the animation tab → lands on the animation section.
8. Confirm **fluid lab** and the **signals** tab still work unchanged (no regress).

## Risks & open questions

- **Audio-dependent backend tests** — mock `signals.extract` where possible so the
  suite doesn't need real stems; keep one optional "real render" behind a marker.
- **mp4 accumulation** — note a cleanup follow-up for `data/fluid/` (animations +
  fluid clips share the dir); not blocking v1.
- **CI vs local** — these are local-dev tests (Postgres + ffmpeg present); document
  prerequisites in the spec/PLAN so the user can run them.
