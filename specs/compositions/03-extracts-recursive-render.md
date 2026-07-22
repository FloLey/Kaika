# 03 — Extracts: data model + recursive render + minimal card UI

The montage rebuilt on composition extracts. **GRAPH_VERSION 29→30**,
**RENDER_VERSION 15→16**.

## Data model (frontend)

- `MontageData`: `extracts: [{id, compositionId, span?, inPoint?}]` +
  `manualBreakpoints: [{id, t}]` + `disabledCuts: number[]` (both in
  composition-LOCAL seconds) + `threshold`/`hysteresis` + ports (opacity/trigger
  only). `MontageSlot` deleted. `span`/`inPoint` stay ABSENT at their defaults so
  untouched extracts hash identically.
- `normalizeGraph`: pre-v30 montage nodes are renamed to a retired sentinel and
  dropped with their edges (the v21 precedent — the slot shape cannot be lifted;
  decision 2 allows the loss). New coercers: `montageExtracts`,
  `manualBreakpoints` (sorted), `numberList`.
- `mutations.ts`: `addExtract` / `removeExtract` / `moveExtract` /
  `setExtractComposition` / `setExtractSpan` / `setExtractInPoint` /
  `addManualBreakpoint` / `moveManualBreakpoint` / `removeManualBreakpoint` /
  `toggleAutoCut(…, tol)` (tolerance = half a frame — a toggled cut round-trips
  through float noise; a cut that MOVED re-enables). All pure data — no edges.
- `lib/montageCuts.ts`: `cutMarks` (provenance rows for the step-06 timeline) /
  `effectiveCuts` / `montageStarts` — the schedule mirror of the backend.
- `lib/compositions.ts` `leafComposition(asset)`: video(sync:"segment") → output,
  the "+ video" shortcut. Segment clock = window-INsensitive = cache-stable under
  retiming.

## Render (backend/graph_render.py)

- `_montage_block` rebuilt: each extract builds a PRIVATE child `Dag` over its
  context window (`Dag` gains `pool`; recursion is the same constructor).
  Whole-clip derives via `_whole_from_block("montage")` — the lazy child-Dag dict
  is created fresh per scan, the `combine` argument — so `_montage_video` is gone
  and whole==streamed holds by construction (`test_card_impact`).
- `_effective_cuts`: gate rises − disabled (±half-frame match) ∪ manual, sorted,
  frame-deduped, clamped inside (0, nframes). `_montage_starts(cuts, spans)` keeps
  the span-consumption/hold-last rule unchanged.
- `_window_sensitive(pool, graph)`: closure holds signal/lyrics or a
  `sync:"song"` video/slideshow → the child renders over its TRUE absolute window
  `{start: cut − inPoint, end: cut_end}` with host signals (decision 1);
  otherwise it renders on the HOST window (extended by the in-point) so its cache
  key never moves with the trigger.
- Extract frame cache: `comp-<output_hash(child ctx)>-<gh>x<gw>`. Appending an
  extract renders only the new one; retiming re-renders only extracts that GREW
  past their cached run (the old block-path rule, now the only rule — the old
  whole path over-rendered full-length runs to buy "retiming renders nothing");
  a shared insensitive composition is cached once across extracts; editing a
  child busts only its extracts.
- In-point: child pulled from `offset = round(inPoint·fps)`; the lead-in advances
  in block chunks (stateful children must be pulled from 0); past-the-child-end
  pads blank (v14). `inPoint ≡ the leaf's video start` byte-exact (the
  montage-resume "align it" contract, pinned by test).
- Child grids resolve per composition (`_grid_dims` over the child's own graph);
  `_fit_frames` reconciles at the composition boundary (cv2 resize).
- Lifecycle: a played-out extract's child Dag closes early (`Dag.close` is
  idempotent; replaces the per-slot closer-snapshot bookkeeping);
  `drop_stale_blocks` forwards into the active child, so peak memory stays one
  block deep per active child.

## Deleted (cleanup mandate)

`_montage_video`, `_montage_srcs`, `_montage_slot_key`, `_feeds_a_montage`, the
`montage_slot` pre-roll exemption in `_video_src0` (v12 — a child's window IS the
extract's, so `sync:"song"` pre-rolls CORRECTLY inside it now),
`_check_montage_exclusivity` (+ its frontend mirror `montageSlotsExclusive`) —
exclusivity holds by construction, `_check_slot_ids` is combine-only, and the new
`_check_montage_extracts` refuses a blank reference. Frontend: `montageSlot`
factory, the four slot mutations (`addMontageInput`/`setMontageSlotSpan`/
`removeMontageInput`/`fillMontageSlots`), `feedsMontage` + the video-card
free-run preview special case, the montage rows in `nodeInputs`/`resolveDropPort`.
`_SLOT_CARDS` → `("combine",)` on both sides (`make gen-params`).

## UI (minimal — the horizontal editor is step 05)

`MontageNode`: extract rows (child composition's name, ×span, window label,
shortfall/duplicate badges, ✕) + **+ video** (AssetLibrary picker →
`leafComposition` into the pool via the new `ctx.updateCompositions` +
`addExtract`). `useMontageShortfall` rewritten on extracts (cut schedule works
from manual breakpoints alone now — the gate is one of two sources, not a
prerequisite; leaf clips read through the pool). `problemsFor`: "no extracts" /
"never cuts (no trigger AND no breakpoints)". Guide prose updated
(`Fx.tsx` montage section, `Cards.tsx` arrange claim, `Sources.tsx` library note,
`paramHelp` extracts/sync entries).

## Playground

The fixture format gains an optional per-demo `compositions` slice (the
reachable closure, exported by `export_playground`; merged into the pool by the
seed — stable `comp-demo-montage-N` ids). The montage demo was rebuilt: 3 leaf
compositions (clip1-3) + extracts; `make seed-playground` pre-renders it through
the real path, and `make export-playground` round-trips it.

## Tests

`tests/test_montage.py` rewritten (30 tests): schedule pure-functions, gate ∪
manual − disabled, hold/span/manual-only/disabled behaviors, re-timing +
in-point equivalence, 3ch child, DEPTH-2 NESTING (whole==streamed), sensitivity
closure walk, missing-reference/no-output/no-extract errors, the four cache
economies, and the played-out-child decoder release. Plus: `test_card_impact`
carries the pool; validation/perf/fixture/nodeInputs/paramHelp/graphConstants
tests updated; frontend extract-mutation + montageCuts suites in
`graphModel.test.ts`; the two montage dom suites rebuilt on pool + extracts.
