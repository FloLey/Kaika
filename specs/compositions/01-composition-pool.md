# 01 — The composition pool: persistence + plumbing (no visible change)

Graphs move from `segment.graph` into a project-level pool `data.compositions`;
each segment references its root composition by id. The editor behaves identically —
this step is pure re-plumbing, gated by "the app is indistinguishable before/after"
(except that pre-existing projects open with empty animations: the migration is
destructive by decision 2).

## Backend

- `db.py`: `SCHEMA_VERSION = 2`. `migrate_project_data`: `< 2` → drop every segment's
  `graph`/`finalOutputId`, set `compositions: {}` (destructive reset — decision 2).
  `save_segments` gains `compositions: dict | None` (a fourth `jsonb_set` branch;
  `None` preserves the stored value, like `output`/`export` — the /segment proposal
  seeding doesn't carry a pool).
- `routes/projects.py`: GET serves `compositions`; PUT passes `body["compositions"]`.
- `song_render.py`: `build_plan`/`_export_hash` take the pool; a segment resolves
  `graph`/`output id` through `pool[seg["rootCompositionId"]]`. `_export_hash` `v: 3`
  (segments carry `rootCompositionId`; the payload folds each root composition).
- `routes/export.py`: `/export/stream` reads the pool from the row; the "final marked"
  check reads `composition.outputId`. `/export/segment*` keeps taking the graph from
  the request body (the client sends the active composition's graph, as before);
  the `seg.get("graph")` / `seg.get("finalOutputId")` fallbacks die. The HD-regen
  asset walks (`_regenerate_hd_images`/`_regenerate_hd_stylize`) walk the body graph,
  unchanged.
- `cache_gc.py`: `_hashes_from` hashes each segment × the outputs of its ROOT
  composition's graph (through the pool); `_assets_from` walks EVERY pool
  composition's nodes (an orphan keeps its assets alive until step 07 prunes it —
  deliberate). The song-export recompute checks `outputId` through the pool.
- `seed_card_demo.py` / `card_demo.py`: the fixture keeps its per-card
  `{key, label, signals, graph}` shape UNCHANGED (a demo IS one composition's
  graph, so no re-export and no format stamp were needed); `build_segments` now
  returns `(segments, compositions)` — one stable `comp-demo-<key>` per demo,
  segment carries `rootCompositionId`. `export_playground` reads each segment's
  graph through the pool (a segment with no animation exports nothing). Additive
  sync appends both halves. `ensure_playground` detects a pre-pool row (segments
  present, none resolving a composition — the v2 migration just stripped it) and
  force-rebuilds from the fixture: the Playground is app-managed, so a
  destructive reseed is its designed recovery, unlike user projects.

## Frontend

- `types.ts`: `Composition`, `CompositionPool`; `Segment` loses `graph`/`finalOutputId`,
  gains `rootCompositionId?`.
- New `lib/compositions.ts`: `mkCompId`, `hydrateCompositions` (KEEPS stored ids —
  the `hydrateSignals` precedent; runs each graph through `normalizeGraph`),
  `createComposition`, and the pool-aware `splitAt`/`copyLayout` re-homes
  (`segments.ts` keeps only pure segment/signal logic).
- `segments.ts`: hydrate/serialize carry `rootCompositionId` verbatim; `splitAt` and
  `copyLayout` move out (they now mint a cloned composition for the target half /
  segment and remap its signal references); `mergeWithPrev` unchanged (the dropped
  segment's composition just loses its reference — orphan GC is step 07).
- `App.tsx`: `compositions` state; `buildSavePayload` gains `compositions`;
  `openProject` hydrates the pool; upload flow seeds `{}`.
- `Studio.tsx`: `setActiveGraph` patches `pool[seg.rootCompositionId].graph`,
  auto-creating the root composition on first edit; `setFinalOutput` writes
  `composition.outputId`; `dropAssetCard`/`hasCards`/copy-layout go through the pool.
- `AnimationCanvas`/`useGraphEditor`: take `graph` + `finalOutputId` as their own
  props instead of reading `segment.graph`/`segment.finalOutputId` (ctx.segment stays
  the time window + signals).
- `ExportStep`: "final marked" check reads the pool (`compositions` prop).
- `api.ts`: project GET/PUT types carry `compositions`.

## Removed (cleanup mandate)

- `Segment.graph` / `Segment.finalOutputId` and every reader.
- `segments.ts` `cloneGraph`-based deep-copy plumbing moves to `compositions.ts`
  in its pool-aware form.

## Tests

- backend: migration drops v1 graphs cleanly (old blob → empty animations, version
  stamped); `save_segments` round-trips the pool and preserves it when `None`;
  `_export_hash` folds the pool (root edit changes it); `cache_gc` keep-set walks the
  pool (reachable root clip survives, unreferenced clip swept); seed builds a pool
  and `export_playground` round-trips it.
- frontend: `hydrateCompositions` keeps ids / mints on dup; split/copy mint new
  compositions with remapped signals; save payload includes the pool.
