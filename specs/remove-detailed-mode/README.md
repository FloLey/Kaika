# Remove the "detailed" card view mode — compact only

> **Status: BUILT** — steps `8a0596a` (00), `ca34fd6` (01, GRAPH 28→29), `3416875` (02),
> `f840fec` (03). 337 vitest / 715 pytest / lint / tsc green.
>
> One finding the research below missed, closed during step 00: the montage **duplicate**
> warning ("two slots, same clip") was per-row-only with no roll-up, so compact-only would
> have dropped it. Per the "compact must do everything" precondition, a duplicate roll-up
> was added to the status line and the compact card (mirroring the black one). The
> **shortfall** warning already had its compact roll-up, so it survived untouched.

Design record for the refactor. Four steps, each a commit-sized unit that ends green
(vitest + pytest + lint + `tsc`).

## Why

The animation editor has two card view modes. **Detailed** renders each card's full body on
the canvas; **compact** renders a small card (header + live preview + one consolidated wire
anchor) whose body opens a settings modal. We are removing detailed and keeping compact only.

## The discovery that makes this cheap

Compact is **not** a reduced re-implementation of each card. `CompactCard` opens
`NodeSettingsModal` (`CompactCard.tsx:131`), which renders the **identical full card
component** — `spec.Component` at `NodeSettingsModal.tsx:196-208` — to edit it, plus an
`InputPicker` panel exposing every param value and wiring source. So the question the task
turns on — *"can compact do everything detailed can, per card?"* — is already **yes for every
card type**. There is nothing to port.

The one apparent exception proves the rule: the **Output** card's HD-render controls
(start/cancel, ⤢ view HD, the `HdViewerModal`) live only in its full body. But output is
**already excluded from compaction** — `renderAnimNode.tsx:26` branches on
`node.type !== "output"`, so output always renders its full body regardless of mode. It keeps
every control. No porting.

## The two decisions (final)

1. **Output stays always-full.** It remains the pipeline preview + HD render surface. No HD
   controls are moved anywhere.
2. **Pure compact — no per-card expand.** `viewOverrides` and the per-card ▢/– expand button
   are removed entirely. Every non-output card is always compact; all editing is via the
   modal.

Decision 2 is what turns this from "delete a toolbar button" into a real refactor: with no
second mode and no per-card override, the whole **two-coordinate apparatus** collapses.

## The coordinate collapse (the substance of the change)

`x/y` are the **detailed** canonical coordinates; `cx/cy` (added at graph v20) are the
**compact** ones. The entire display-node indirection —
`displayNode`/`toDisplay`/`applyDisplayUpdater` plus a `displayCache` WeakMap
(`useGraphEditor.ts:50-94, 223-254`) — exists *only* to keep two coordinate sets and translate
`GraphCanvas` commits between them. `GraphCanvas` itself always renders from `n.x/n.y`.

With detailed gone we **fold `cx/cy` into `x/y`** (migration) and delete all four helpers plus
the WeakMap. `displayGraph` becomes `graph`. This is the recommended approach over "keep cx/cy
as the live coord": keeping cx/cy would force `toDisplay` to survive just to map cx→x for the
canvas, leaving dead x/y writes. Folding gives one coordinate the canvas already reads.

Memo identity is **preserved, not lost**: real nodes replace the display wrappers, and
`normalizeGraph`'s structural sharing keeps node identity stable across commits exactly as the
WeakMap did.

## Version impact

- `GRAPH_VERSION` **28 → 29** — the persisted shape changes (`cx/cy`, `viewMode`,
  `viewOverrides` all removed). A `normalizeGraph` migration folds and drops them.
- **No `RENDER_VERSION`.** Verified: `outputHash` serializes only `{id, type, data}` per node
  (`hash.ts:93`) — it never reads `x/y`, `cx/cy`, `viewMode`, or `viewOverrides`. Toggling
  never busted the render cache; removal doesn't either.

## The steps

| # | File | What | Version |
|---|---|---|---|
| 00 | [00-flip-to-compact-and-remove-toggle.md](00-flip-to-compact-and-remove-toggle.md) | Behaviour flip + delete toggle/override UI; coords & schema left intact | — |
| 01 | [01-collapse-coordinates-and-migrate.md](01-collapse-coordinates-and-migrate.md) | Fold `cx/cy → x/y`, delete the display apparatus, drop the schema fields | **GRAPH 28→29** |
| 02 | [02-layout-dead-code-sweep.md](02-layout-dead-code-sweep.md) | Remove `layout.ts` code only the deleted mode-switch used | — |
| 03 | [03-docs-and-css.md](03-docs-and-css.md) | Compact-only prose in the in-app guide; drop dead CSS | — |

**Why this order.** Step 00 flips behaviour while leaving `cx/cy`/`viewMode`/`viewOverrides`
inert, so the position tests and the v16-migration test stay green — the deletion of the
coordinate machinery (step 01) then has a working baseline to remove against. Splitting them
keeps the version-bump commit small and reviewable, and means a bisect can tell "behaviour
wrong" from "migration wrong".

## End-state invariant (a new test pins it)

In `animationCanvas.dom.test.tsx`:
1. Every non-output card renders compact (`.anim-node.compact` / `.anim-compact-body`).
2. The output card renders its full HD body — never compact.
3. An old `viewMode:"detailed"` save with no `cx/cy` opens compact at its `x/y`.
4. A save carrying `cx/cy` opens with those folded into `x/y`.

## Risks

| Risk | Reality |
|---|---|
| **Cards move on migration** | A project last viewed in *detailed* jumps to its compact positions on open. Unavoidable and correct — compact is all that remains. A project never compacted (no `cx/cy`) keeps `x/y` byte-for-byte, identical to today's `displayNode` fallback (`useGraphEditor.ts:52-53`). |
| **Deleting `DETAILED_SIZES.output`** | ⚠ Don't. `estimateCardSize(type,"compact")` returns it for output, and `reorganize`/`flowLayout` need the real output footprint or ✨ arrange collapses output onto its neighbours. |
| **`estimateCardSize` signature** | Depended on by `playgroundFixture.test.ts:55` — keep the 2-arg form or update that one call. |
| **Memo re-renders** | Non-issue — see the coordinate-collapse section. Identity is at least as stable as the WeakMap gave. |

## Not in scope

HD-control porting (output stays full, so there's none). Any `RENDER_VERSION` change. The
compact card's own internals — `CompactCard` is unchanged; it is simply the only path now.
