# 07 — DAG sharing: reuse, cycle refusal, refcounts, orphan prune

The pool becomes a real DAG in the UI: several extracts (in one montage or many)
reference the SAME composition, and its lifecycle is safe.

## Lifecycle (`lib/compositions.ts`)

- `wouldCycle(pool, hostId, childId)` — true iff the host is reachable from the
  child (or is the child): the reuse picker filters those out AT THE SOURCE;
  backend `validate_pool` (step 02) 400s as the belt-and-braces.
- `refCounts(pool, segments)` — segment roots + every montage extract, counted
  PER EXTRACT (two extracts of one composition are two places; the closure set
  would fold them). Studio memoizes it and threads it as `ctx.refCounts`
  (+ `ctx.compositionId`, the composition the canvas edits).
- `pruneOrphans(pool, segments)` — drops everything unreachable from the roots
  (whole chains included), identity-stable when clean. Applied in TWO places
  and deliberately NOT to the in-memory state: `openProject` (collects past
  sessions' orphans) and `buildSavePayload` (the DB never stores one) — so an
  in-session undo that restores the last reference finds the composition still
  in memory and simply saves it again. The pop-on-vanish guard (step 04/05)
  keeps a deleted-under-you frame safe.

## UI (montage editor + breadcrumb)

- **⟳ reuse** tile: lists the pool with `used ×N`, self/ancestors hidden;
  picking adds an extract referencing the existing composition.
- **✕ with a conscience**: removing the LAST reference confirms ("…will delete
  the composition on the next save"); other references remove silently, and the
  button's tooltip names the survivor count.
- **Rename**: double-click the breadcrumb's current crumb (comp frames) —
  a shared composition's name is how every referencing tile identifies it.

## Tests

- `compositionPool.test.ts`: wouldCycle (self/ancestor/transitively; siblings
  and descendants allowed), refCounts (nested + duplicate extracts), prune
  (chains, shared-survivor, identity when clean).
- `montageSharing.dom.test.tsx`: the picker hides self + ancestor, shows
  `used ×1`, adds on pick; last-reference ✕ confirms then removes.
- `compositionHash.test.ts`: editing a shared child busts EVERY referencing
  root's key — the propagation contract.
