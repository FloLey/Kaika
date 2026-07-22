# 02 — Pool-aware hashing, validation and render requests

Render requests carry the composition pool; `output_hash` folds the RECURSIVE
closure of compositions a montage's extracts reference; the pool's reference DAG
is validated acyclic at the boundary. Also lands `SignalData.ref` — the signature
fallback that makes a SHARED composition audio-reactive under any host segment.

Montage extracts themselves land in step 03; everything here reads
`data.extracts` forward-compatibly (empty until then), so this step is pure
infrastructure with **zero hash movement** for existing graphs.

## Hashing

- `output_hash(..., pool=None)` (`graph_hash.py`): when the CONTRIBUTING sub-DAG
  holds a montage referencing compositions, the payload gains a `compositions`
  key — the sorted recursive closure, each entry
  `[id, resolved outputId, canonicalized graph]` (`_graph_for_hash`: layout
  stripped, unwired slots dropped, loose edges filtered, referenced signal defs
  resolved against the HOST segment's signals — the contextual time base). A
  dangling reference folds as `[id, null]` (appearing/breaking moves the key).
  **The key is ABSENT when nothing is referenced**, so every pre-pool graph keeps
  its exact hash — no RENDER_VERSION bump for plumbing.
- A `lyrics` node inside a referenced composition folds the segment's overlapping
  lyric lines exactly like a top-level one.
- `compositions.py`: `referenced_composition_ids(graph)` (montage extracts) +
  `composition_closure(pool, seeds)` (ordered, cycle-safe).
- `song_render._export_hash`: gains a `refs` key (closure beyond the roots),
  conditional the same way — a project with no extracts keeps its v3 hash.
- `cache_gc._hashes_from` passes the pool through, so GC keep-sets stay exact
  once extracts exist.
- Frontend mirror (`lib/graph/hash.ts` `outputHash(..., compositions?)`,
  `lib/graph/core.ts` `referencedCompositionIds`): the frontend key only gates
  re-POSTs (FNV vs the backend's SHA-1 — value parity is impossible and not the
  contract); what the tests pin on BOTH sides is the same **sensitivity**: child
  edit moves the key, unreferenced edit doesn't, no-reference graphs unchanged.

## Validation & routes

- `graph_validate.validate_pool(pool)`: the composition-REFERENCE graph must be
  acyclic (self or transitive containment refused, 400 at the boundary); entries
  must carry a graph. Deliberately does NOT full-validate every entry — rendering
  composition A must not fail because composition B is mid-edit; each composition
  is fully validated when IT renders. Exported through the `graph.py` facade.
- `/animate/stream` and `/export/segment(+/cached)` accept `compositions`
  (optional), validate the pool, and thread it into `render_stream`/`_hd_paths`
  (`render`/`render_stream` gained a `pool` kwarg). `/resolve*` doesn't take it —
  value curves never depend on the pool.
- The frontend ships only the **reachable slice**
  (`lib/compositions.ts reachableSlice` — undefined for the common no-montage
  case, so preview POSTs carry no extra weight). `NodeCtx.compositions` threads
  Studio → AnimationCanvas → useGraphEditor → useRenderKey / useStreamRender /
  OutputNode's HD body.

## SignalData.ref (the shared-composition signal fallback)

- `SignalData.ref?: {stemKey, minHz, maxHz, feature}` — written by
  `factories.signalNode` at pick time (the one place the whole Signal is in
  hand). `normalizeGraph` has no schema for the signal card, so the field
  round-trips old saves untouched; no backfill (decision 2: no data to preserve).
- Backend `graph_common.resolve_signal(node_data, signals_by_id)`: exact
  `signalId` first, else the signature match — used by BOTH the render
  (`graph_modulators._signal_curve`) and the hash
  (`graph_hash._referenced_signal_defs`), so the key always covers the signal
  that actually shapes the frames.

## Tests

- `tests/test_composition_hash.py`: pool arg invisible to reference-free graphs;
  child/grandchild edit busts the root; unreferenced edit doesn't; dangling refs
  and child ★ marks move the key; `validate_pool` accepts DAG + dangling, refuses
  cycles/self-cycles/graphless entries; `/animate/stream` 400s a cyclic pool;
  `resolve_signal` precedence + the hash covering signature-matched signals.
- `frontend/src/__tests__/compositionHash.test.ts`: the same sensitivity matrix
  on the mirror + `reachableSlice`/`referencedCompositionIds`.
