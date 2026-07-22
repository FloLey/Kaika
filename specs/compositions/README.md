# Compositions — a DAG of nested, shared compositions

> **Status: BUILT** — steps `9ed15ff` (01), `5a8402d` (02), `2478fe1` (03, GRAPH 30 +
> RENDER 16), `9d6d803` (04), `d9fcb8f` (05), `02da545` (06), `61be1a9` (07),
> `2f8dd54` (08), + the docs sweep (09). Every commit green (pytest + vitest +
> lint + `tsc --noEmit`); the Playground reseeded and re-exported through the
> new path along the way.

Design record for the montage rework: replace "one node graph per segment" with a
**pool of compositions** addressed by id. A *composition* is a small graph ending in an
`output` card and producing a video — the unit of editing and reuse. The montage card
becomes a composition whose output is the temporal concatenation of *extracts*, each
extract referencing a child composition (recursively; sharing forms a DAG).

## Decisions (locked with the user, 2026-07-22)

1. **Contextual time base.** A composition renders in the context of the extract that
   references it: the extract's absolute song window, the host segment's signals. The
   same shared composition under two different windows renders twice — semantically
   necessary for audio-reactive content. True cache dedup applies to window-INsensitive
   content (leaf videos in local time) and to identical windows.
2. **No data preservation.** Existing projects may be broken or wiped; the migration is
   a clean destructive reset (old projects open with empty animations, never crash).
3. **Step-by-step delivery, full scope.** Nothing descoped; each step is a green commit.
4. **Montage ports = `opacity` + `trigger` only.** Slot input ports are deleted;
   extracts are id references. `threshold`/`hysteresis` stay static `data` fields.
5. Montage stays a card (composable into merge/combine); *leaf* composition =
   `video → output`, and "pick a video" in the strip is a shortcut that creates exactly
   that; breakpoints are the live union of gate cuts and manual cuts with colored
   provenance and per-cut disabling; navigation is a breadcrumb, one composition's
   graph on screen at a time.

## Target data model

DB document (`SCHEMA_VERSION` 1→2, destructive):

```jsonc
{
  "schema_version": 2,
  "stems": {...},
  "segments": [{ "id", "label", "start", "end", "signals": [...],
                 "rootCompositionId": "comp-3fa9c1d2" }],   // replaces graph + finalOutputId
  "compositions": {                                          // THE POOL, keyed by id
    "comp-3fa9c1d2": { "id", "name", "graph": {...}, "outputId": "n12" }
  },
  "output": {...}, "export": {...}, "assets": [...]
}
```

- The pool rides **in the autosave with the segments** (a `jsonb_set` branch in
  `db.save_segments`) — not out-of-band like assets: assets are out-of-band only
  because the *server* appends them concurrently; the pool is client-owned editable
  state exactly like graphs were.
- **Stable ids** (`comp-<uuid8>`), preserved on load — the `hydrateSignals` precedent,
  not `hydrateSegments`' fresh-mint. Node ids stay unique *per composition*.
- `Composition.outputId` replaces `segment.finalOutputId` (the ★-final mark lives on
  the composition; defaults to the sole output when there is exactly one).

Montage card data (lands in step 03, GRAPH_VERSION bump):

```ts
interface MontageExtract {
  id: string;              // stable extract identity (UI keys, cache claims)
  compositionId: string;   // the DAG edge
  span?: number;           // cuts swallowed (absent = 1)
  inPoint?: number;        // seconds into the child's local clock (absent = 0)
}
interface ManualBreakpoint { id: string; t: number }  // seconds, LOCAL to the composition window
interface MontageData {
  extracts: MontageExtract[];
  manualBreakpoints: ManualBreakpoint[];
  disabledCuts: number[];  // disabled GATE cuts, local seconds (frame-rounded)
  threshold: number; hysteresis: number;
  ports: { opacity, trigger };  // slot ports are gone
}
```

- Manual breakpoints and `disabledCuts` are in **composition-local seconds** (0 =
  window start) — what makes recursion coherent.
- A recomputed gate cut is *disabled* iff a `disabledCuts` entry lies within half a
  frame of it; a cut that moved (threshold edit) re-enables. Deterministic, hashable,
  mirrored front/back.
- **Effective cuts** = sort(gate rises − disabled ∪ manual), deduped at frame
  granularity (gate wins for provenance display), then exactly the old
  `_montage_starts` span-consumption logic.
- `inPoint` subsumes `specs/montage-resume`: Part 2's "align it" becomes "set this
  extract's inPoint to where the previous occurrence left off"; Part 1 becomes the
  shared-child duplicate badge.

## Render design: recursive child Dag per extract (NOT inlining)

An extract's producer = "build a child `Dag` over the extract's window, pull its output
with local block ranges". Flattening is rejected: two windows can't share one Dag
(signals/lyrics/curves resolve over `dag.segment` at construction); per-composition
cache keys need the child graph as a unit; node ids collide across compositions; and
exclusivity + decoder lifecycle get *simpler* — each extract owns a private child Dag,
so `_check_montage_exclusivity` and `_feeds_a_montage` are deleted (the property holds
by construction) and releasing a played-out extract is `childDag.close()`.

- `Dag` gains `pool`; only the montage handler reads it; nesting recurses free.
- The montage derives `_whole_from_block("montage")`: the block handler's cross-block
  state (lazy child-Dag dict) is created fresh per scan, so one `produce(0, n)` IS the
  whole clip — the same argument that let `combine` derive. One implementation,
  whole==streamed parity by construction.
- **Cache keys** (replace `_montage_slot_key`), by a recursive
  `_window_sensitive(pool, comp_id)` predicate (closure contains a `signal`/`lyrics`
  node or a `video`/`slideshow` with `sync=="song"`):
  - sensitive child → rendered over its true absolute window
    `{start: t0 − inPoint, end: t1, signals: host}`; window in the key.
  - insensitive child (leaf videos, const/LFO generative) → the HOST window
    (extended by the in-point), so the key never moves with the trigger: retiming
    re-renders only extracts that GREW past their cached run, appending renders
    only the new one, and a shared composition is cached once across extracts.
- `output_hash` gains the recursive closure of referenced compositions, so editing a
  child busts the root's clip, and `cache_gc` can recompute keep-sets from the DB.
- Leaf video cards are created `sync:"segment"`, so the `montage_slot` pre-roll
  special case (`_video_src0`, RENDER_VERSION v12) is deleted, not generalized.
- `RENDER_VERSION` 15→16 when the montage semantics land (step 03).
- **`layer` continuity rule** (whole-song export): persistent-field continuity applies
  only to fluids in the segment's ROOT composition graph; fluids inside child
  compositions re-simulate per extract window. This is today's behavior (montage is
  deliberately not in `_field_nodes`) promoted to a documented rule.

## Steps

| Step | What | Key surface |
|---|---|---|
| [`01`](01-composition-pool.md) ✅ `9ed15ff` | The pool: persistence + plumbing, no visible change | db, routes, segments.ts, compositions.ts, App/Studio, song_render, cache_gc, seed |
| [`02`](02-pool-aware-hashing.md) ✅ | Pool-aware hashing, validation, render requests | graph_hash, graph_validate, animation routes, hash.ts, SignalData.ref |
| [`03`](03-extracts-recursive-render.md) ✅ | Extracts: data model + recursive render + minimal card UI | GRAPH 30, RENDER 16, graph_render rebuild, fixture format |
| [`04`](04-breadcrumb-navigation.md) ✅ | Navigation: breadcrumb + per-composition canvas | Studio nav stack, window snapshot, viewSegment |
| [`05`](05-montage-editor.md) ✅ | The horizontal montage editor (strip + live pane) | MontageEditor.tsx, enterMontage frame |
| [`06`](06-breakpoints-timeline.md) ✅ | Breakpoints timeline (provenance colors, per-cut disable) | BreakpointTimeline.tsx |
| [`07`](07-dag-sharing.md) ✅ | DAG sharing: reuse picker, cycle refusal, refcounts, orphan prune | compositions.ts, refCounts ctx, prune-on-save |
| [`08`](08-export-cache-hardening.md) ✅ | Export + cache hardening (layer rule, GC safety) | song_render, cache_gc, export_segment tests |
| `09` ✅ | Docs & polish sweep | ARCHITECTURE, README, DEVELOPMENT, guide, montage-resume note |

Cleanup mandate (user): delete aggressively in the same commit that makes code dead —
no compat layers, no just-in-case code. Each step file records what was removed.
