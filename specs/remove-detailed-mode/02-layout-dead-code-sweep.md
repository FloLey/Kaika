# Step 02 — Sweep the layout code the deleted mode-switch used

**Goal.** Remove the `lib/graph/layout.ts` functions that only the now-deleted mode machinery
called, and simplify the mode-keyed size/gap lookups to the single (compact) view. Pure
dead-code removal — no behaviour change.

**Blocked by.** Step **01** (which deletes `layoutForMode`, the sole caller of the functions
swept here).

**Size.** S.

> Line numbers are a snapshot — re-grep before relying on one.

---

## What became dead

`layoutForMode` (deleted in step 01) was the only caller of both `tighten` (`layout.ts:406`)
and `resolveOverlaps` (`:69`), via `useGraphEditor.ts:85`
(`firstCompactEntry ? tighten(rects) : resolveOverlaps(rects)`). ✨ arrange uses `flowLayout`,
not these.

⚠ **Before deleting `resolveOverlaps`, confirm `flowLayout` doesn't call it internally.**
Grep `resolveOverlaps` across `layout.ts`; if `flowLayout` uses it, keep it and delete only
`tighten`.

## Deletions

- `layout.ts`: delete `tighten` (`:406-…`). Delete `resolveOverlaps` (`:69-…`) **only if** the
  grep above is clean.
- `lib/graphModel.ts:94`: drop `resolveOverlaps` / `tighten` from the re-export barrel (leave
  `flowLayout`, `estimateCardSize`, `FLOW_GAPS`).
- `useGraphEditor.ts:20-21`: drop the now-unused `resolveOverlaps` / `tighten` imports (should
  already be gone if step 01 removed `layoutForMode` cleanly — verify).

## Simplify the mode-keyed lookups

### `estimateCardSize` (`:54-57`)

Today:
```ts
export function estimateCardSize(type: string, mode: "detailed" | "compact"): CardSize {
  if (mode === "compact" && type !== "output") return COMPACT_SIZE; // output never compacts
  return DETAILED_SIZES[type] || DETAILED_DEFAULT;
}
```

There is one view now: non-output cards are compact, output is full. Two options —

- **Minimal (recommended):** keep the 2-arg signature, ignore `mode`:
  ```ts
  export function estimateCardSize(type: string, _mode?: "compact"): CardSize {
    return type === "output" ? DETAILED_SIZES.output : COMPACT_SIZE;
  }
  ```
  This leaves `playgroundFixture.test.ts:55`'s 2-arg call working untouched.
- **Thorough:** drop the param and update the one call at `playgroundFixture.test.ts:55`.

Either is fine; the minimal one is a smaller diff. `DETAILED_SIZES` is now read **only** for
`output` — you may prune the map to `{ output }` (+ `DETAILED_DEFAULT` if any caller can pass
an unknown type), but ⚠ **keep `DETAILED_SIZES.output`** either way: `reorganize`/`flowLayout`
need the real output footprint or ✨ arrange collapses output onto its neighbours.

### `FLOW_GAPS` (`:109`)

Keyed `Record<"detailed" | "compact", FlowGaps>`. Only `FLOW_GAPS["compact"]` is read now
(`reorganize`, step 01). Either keep both entries (harmless) or collapse to a single
`FLOW_GAPS: FlowGaps` and update `reorganize`'s reference. Collapsing is cleaner but touches
`reorganize` again — do it only if step 01's `reorganize` edit hasn't already shipped.

## Tests

- `layout.test.ts:171-239` — delete the `tighten` (and `resolveOverlaps`, if removed) cases and
  any `estimateCardSize(type, "detailed")` assertion. Keep the `flowLayout` / `FLOW_GAPS`
  cases; adjust `estimateCardSize` cases to the single-view contract (output → full,
  everything else → compact).

## Verification

1. `npx tsc --noEmit` — no unused-import or missing-export errors.
2. `npm run test` — green.
3. `npm run lint`.
4. By hand: ✨ arrange still lays cards out sensibly, output keeps its full footprint and does
   not overlap its neighbour.

## Acceptance

- `tighten` gone; `resolveOverlaps` gone (or documented as kept because `flowLayout` uses it).
- `estimateCardSize` no longer branches on a live `mode`; `DETAILED_SIZES.output` preserved.
- Barrel re-exports and imports cleaned; suite green.

## Risks

- **Deleting `resolveOverlaps` while `flowLayout` needs it.** The grep gate above is the guard.
- **Pruning `DETAILED_SIZES` too far.** Keep `output` (and a default for unknown types if any
  path can produce one).
