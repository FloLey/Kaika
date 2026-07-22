# Step 01 — Collapse `cx/cy → x/y`, delete the display apparatus, drop the schema fields

**Goal.** One coordinate set. Fold each node's compact position (`cx/cy`) into the canonical
`x/y`, delete the entire display-node indirection that only existed to serve two coordinate
sets, and remove `viewMode`/`viewOverrides`/`cx/cy` from the persisted graph. Bump
`GRAPH_VERSION` **28 → 29** with a `normalizeGraph` migration.

**Blocked by.** Step **00** (behaviour must already be compact-only; this deletes the now-dead
machinery under it).

**Size.** M — small diff, wide blast radius (every position write in the editor).

> Line numbers are a snapshot — re-grep before relying on one.

---

## Why fold instead of keeping `cx/cy`

`GraphCanvas` renders from `n.x/n.y`. The apparatus that keeps `cx/cy` separate —
`displayNode`/`toDisplay`/`applyDisplayUpdater` + the `displayCache` WeakMap
(`useGraphEditor.ts:50-94, 223-254`) — exists *only* to translate the canvas's `x/y` commits
onto the compact `cx/cy`. With detailed gone there is one view, so the compact position
**is** the position: fold `cx/cy` into `x/y` and the whole apparatus deletes. Keeping `cx/cy`
as the live coord would force `toDisplay` to survive purely to map cx→x for the canvas, and
leave dead `x/y` writes behind — strictly worse.

## The migration (`lib/graph/normalize.ts`)

`normalizeGraph` already migrates by re-stamping and stripping legacy fields — the v16 block
strips pre-v13 `minimized`/`expanded` the same way (`:481, :486-487`). Add:

1. **Per node**, in the map at `:345-…`, fold and drop the compact coords:
   ```ts
   if (n.cx != null || n.cy != null) {
     n = { ...n, x: n.cx ?? n.x, y: n.cy ?? n.y };
     delete (n as Record<string, unknown>).cx;
     delete (n as Record<string, unknown>).cy;
     changed = true;
   }
   ```
   ⚠ Idempotent: after the first run no node has `cx/cy`, so this is a no-op on re-load.

2. **Graph fields**, replacing the v16 `viewOverrides`-pruning block (`:469-485`): drop both
   `viewMode` and `viewOverrides` on `out`, mirroring the existing
   `delete out.expanded; delete out.minimized;` at `:486-487`:
   ```ts
   if (graph.viewMode !== undefined || graph.viewOverrides !== undefined) changed = true;
   ...
   delete out.viewMode;
   delete out.viewOverrides;
   ```
   Keep the existing legacy `expanded`/`minimized` strip — those are older saves that never
   got the v16 fields.

3. Update the migration comment to explain v29 (one view; compact coords fold into `x/y`; the
   mode fields are gone), following the style of the v8/v15/v21 notes above it.

## The version stamp

- `factories.ts:160`: `GRAPH_VERSION = 29`, and add a v29 line to the changelog comment
  (`:126-127` area) — "removed the detailed view: `viewMode`/`viewOverrides` dropped, per-view
  `cx/cy` folded into `x/y`."
- **No `RENDER_VERSION`.** `outputHash` serializes only `{id, type, data}` (`hash.ts:93`); none
  of these fields reach it. State this in the commit message so a reviewer doesn't look for a
  missing bump.

## Delete the display apparatus (`useGraphEditor.ts`)

- `displayCache` WeakMap + `displayNode` + `toDisplay` (`:50-65`) — gone.
- `layoutForMode` (`:76-94`) — gone (it existed only to seed the *other* view's coords on a
  mode switch, and there is no other view). Step 02 removes its now-orphaned callee `tighten`.
- `displayGraph` (`:223-226`) — `GraphCanvas` now takes `graph` directly.
- `applyDisplayUpdater` (`:235-254`) — gone; every caller uses `applyUpdater`. Its callers are
  `reorganize` (`:309`), the node ctx `onGraphChange` (`:462` area), and the hook return
  (`:494` area). `reorganize` already reads `n.x/n.y` (`:314, :319`) so it works verbatim on
  `applyUpdater`; drop its `mode` variable (`:311`) and pass `"compact"` inline to
  `estimateCardSize`/`FLOW_GAPS` (until step 02 removes the mode param entirely).

## Schema (`lib/types.ts`)

- Remove `cx?`/`cy?` from the node type (`:435-436`).
- Remove `viewMode?`/`viewOverrides?` from `Graph` (`:655-658`).

Everything typed that referenced them now fails `tsc` — that is the checklist for stragglers.

## `mutations.ts`

- `:354-356` — the `removeNode` helper prunes `viewOverrides`. Dead now (normalize drops the
  field, and nothing writes it). Delete it.

## Tests

- **Delete** `graphEditorDisplay.test.ts` — it tests `layoutForMode`/`displayNode`/`toDisplay`,
  all gone.
- `graphModel.test.ts:861-902` — the v16 migration cases. Rewrite as a **v29** test:
  - a save with `cx/cy` opens with those folded into `x/y` and `cx/cy` absent;
  - a save with `viewMode:"detailed"` / `viewOverrides:[…]` opens with both fields gone;
  - a save with neither keeps `x/y` untouched (byte-for-byte);
  - idempotent: normalize twice == once.
- `animationCanvas.dom.test.tsx` position-drag case (~`:178-259`) — assert against the single
  `x/y` coordinate now (no display-space translation to account for).

## Verification

1. `npx tsc --noEmit` — the type removals surface every straggler; fix until clean.
2. `npm run test` — green, with the deleted/rewritten migration tests.
3. `npm run lint`.
4. By hand (`make dev`): open a project saved in the OLD detailed mode → it opens compact with
   cards at their `x/y`; open one previously compacted (has `cx/cy`) → cards sit at the folded
   positions; drag a card, reload → position persisted on `x/y`. Inspect the saved graph JSON
   (DB or the project export): **no** `cx`/`cy`/`viewMode`/`viewOverrides`, and `version: 29`.

## Acceptance

- `GRAPH_VERSION === 29`; migration folds `cx/cy → x/y` and drops the mode fields, idempotently.
- `displayNode`/`toDisplay`/`applyDisplayUpdater`/`layoutForMode`/`displayCache` all deleted.
- `lib/types.ts` no longer declares `cx`/`cy`/`viewMode`/`viewOverrides`.
- No `RENDER_VERSION` change.

## Risks

- **A drag that lands on the wrong coordinate.** The whole point of `applyDisplayUpdater` was
  routing writes to `cx/cy`; removing it means writes go to `x/y` directly, which is correct
  now but is the one thing to exercise by hand (drag → reload → still there).
- **Migration order.** Fold `cx/cy` inside the existing per-node map so it composes with the
  type coercions; don't add a second pass over the nodes.
- **Old saves jumping position.** Expected and documented (README risk table) — a
  detailed-only save surfaces its compact layout for the first time.
