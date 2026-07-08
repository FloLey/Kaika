# Improvement batch — bug fixes, dedup, UX polish, and the Transform card

> **Status: implemented.** It came out of a full-codebase review (backend, frontend,
> `docs/history/`, `specs/`); everything below has landed. Three bugs were found
> *during* implementation that the review had missed — see "Found while building".

## What the review found

Four clusters, one spec each:

| Spec | Cluster | Contents |
|------|---------|----------|
| `01-bug-fixes.md` | Bugs | HD-export assets unserveable/undeletable; whole-song export live preview 404s; job polling never aborted; `useResolvedPoints` stale closure |
| `02-dedup-refactors.md` | Dedup | Backend: `resolve_port`, `StreamEncoder`, `/resolve` twins. Frontend: one streaming hook instead of three copies, `usePreservePlayback`, `useSyncedPlayback`, `jobIdOf` |
| `03-ux-polish.md` | UX | Visible undo/redo, export-checklist click-through, `ConfirmDialog` replacing `window.confirm`, autosave badge on Export |
| `04-transform-card.md` | Feature | The Transform/Kaleidoscope video-FX card — specced in `specs/playground-cards/03-video-fx-cards.md` (C1), never shipped |

### Explicitly dropped (checked, not bugs — don't re-propose)

- **`OLLAMA_MODEL` default `qwen3.6:35b-a3b`** (`backend/llm.py:16`) looked like a
  typo'd tag; `ollama list` shows the model installed. Correct as-is.
- **`graph_render.render_stream`'s render id** is fine — it's `output_hash` hex +
  uuid hex, already alphanumeric. Only `song_render.py` trips the serving gate
  (see spec 01).
- Everything under "Accepted trade-offs" in `ARCHITECTURE.md` (200 MB body cap,
  GC-deferred file deletion, cross-job asset reads, `_gate_curve` loop) stays accepted.
- `ExportStep`'s own poll loop is **kept** (deliberate deviation — see spec 02 §F3).

## Build order & commit sequence

Refactors land **before** the Transform card so the card is built on the shared
helpers (`resolve_port` feeds its handlers; the stream hooks feed its preview).
Direct to `main`, every commit green: `make test`, `make lint`,
`cd frontend && npx tsc --noEmit`.

| # | Commit | Spec |
|---|--------|------|
| 1 | backend: `validate_asset_id` + song-export stream id | 01 §A, §B |
| 2 | frontend: `pollJob` abort + `useResolvedPoints` deps | 01 §C, §D |
| 3 | backend: `resolve_port` + `StreamEncoder` + `/resolve` twins | 02 §B1–B3 |
| 4 | frontend: `useStreamRender` slot option + `usePreservePlayback` + `useSyncedPlayback` | 02 §F1–F3 |
| 5 | frontend: `jobIdOf` helper | 02 §F4 |
| 6 | undo/redo toolbar buttons | 03 §U1 |
| 7 | export checklist click-through | 03 §U2 |
| 8 | `ConfirmDialog` replaces `window.confirm` | 03 §U3 |
| 9 | saveError badge on Export stage | 03 §U4 |
| 10 | Transform video-FX card | 04 |

## Found while building (not in the original review)

Three real bugs surfaced only once the code ran. Each is fixed with a regression test
that fails on the old behaviour:

1. **A card preview 400s whenever the graph has no output node.** `validate()` demanded
   an output node even when `output_id` names a producer previewed *directly* — which
   contradicts the documented `_render_target` contract, and made "drop a card, wire
   nothing yet" an error. `validate(graph, output_id)` now keys the output-node rules off
   the render target. (`tests/test_graph_validation.py`)
2. **The Playground's Color demo lost its card the moment the UI loaded it.** The fixture
   graphs carried **stale `version` stamps** (v6) while holding modern data, so
   `normalizeGraph` ran the pre-v8 migration and renamed the dye `color` card to `grade`,
   dropping it. Invisible to pytest, which never normalizes. All fixture graphs are now
   stamped at `GRAPH_VERSION`, and a new frontend guard
   (`__tests__/playgroundFixture.test.ts`) runs every pipeline through `normalizeGraph`
   and fails if it loses its card. **This is the frontend half of the "every card needs a
   Playground pipeline" invariant.**
3. **`test_card_impact`'s blankness check was too lax.** `frames.max() > 0` passed a
   kaleidoscope demo that rendered `max=2` (visually black). Every real demo clears
   `max>=216` and lights `>=6.7%` of its pixels, so the check now enforces
   `peak >= 32` and `lit >= 0.5%`.

Also fixed: `usePreservePlayback().reset()` returned `0` from an arrow body; called
straight from an effect, React read it as a cleanup function and crashed OutputNode with
"destroy is not a function" (`__tests__/preservePlayback.dom.test.tsx`).

Two plan assumptions proved wrong and were corrected in place:

- **`canUndo`/`canRedo` can't be read from the history ref at render time.** The graph is
  *controlled* by the parent (`commitGraph` is a prop), so a commit the parent ignores
  leaves the buttons stale. The history **depth** is now state.
- **`resolve_port` must return `pdef` uncoerced.** `float(pdef)` would rewrite int
  defaults (`40` → `40.0`) into `params_hash`'s JSON and silently invalidate every
  raw-frame cache entry.

## Verification (whole batch)

Beyond the per-commit gates:

- **Bugs, end-to-end** (`make dev`): run an HD export containing an ✨ image-gen
  card — the generated asset's thumbnail loads in the 📚 library and its 🗑 delete
  works; while the export renders, the progress preview `<video>` plays (today it
  404s until the final file exists).
- **Transform, end-to-end**: drop a Transform between a fluid and its output, wire
  `rotate` to a signal — the streamed preview reacts; run one whole-song HD export
  containing it (exercises `graph_common._field_nodes`' pass-through).
- **Docs invariants hold**: `make gen-params` re-run produces no diff;
  `make export-playground` output is committed with commit 10;
  `tests/test_card_impact.py` (every card has a working Playground demo) and the
  `paramHelp`/Docs anchor-guard tests pass.
