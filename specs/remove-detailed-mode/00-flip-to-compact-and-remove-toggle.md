# Step 00 — Flip to compact, delete the toggle and the per-card override

**Goal.** Every non-output card renders compact, always. No toolbar toggle, no per-card ▢/–
button. **Coordinates and the graph schema are left untouched** this step — `cx/cy`,
`viewMode`, `viewOverrides`, and the whole `displayNode`/`toDisplay` apparatus stay in place
but inert. That keeps the position tests and the v16-migration test green, giving step 01 a
working baseline to delete the machinery against.

**Blocked by.** Nothing.

**Size.** M.

> Line numbers are a snapshot — re-grep before relying on one.

---

## The core: three edits

### 1. `renderAnimNode.tsx:26` — the branch loses its condition

```tsx
// before
if (ctx.minimized && ctx.minimized.has(node.id) && node.type !== "output") {
// after
if (node.type !== "output") {
```

Everything non-output is compact; output alone renders `spec.Component`. `ctx.minimized` no
longer gates anything here (it can still exist this step — see below).

### 2. `useGraphEditor.ts` — `minimized` becomes "all non-output"

`minimized` (`:263-275`) currently reads `viewMode` and `overrides`. Replace its body with the
constant set:

```ts
const minimized = useMemo(
  () => new Set(graph.nodes.filter((n) => n.type !== "output").map((n) => n.id)),
  [graph.nodes]
);
```

Then delete, in the same file:
- `const viewMode = graph.viewMode || "detailed";` (`:218`)
- `overrides` (`:256-259`)
- `toggleMinimize` (`:276-286`)
- `setViewMode` (`:290-300`)
- `viewMode` / `setViewMode` from the hook's return (`:499` area)

⚠ **Leave `displayGraph` = `toDisplay(graph)` and `applyDisplayUpdater` as they are** for now,
but they no longer branch on `viewMode`. `applyDisplayUpdater` (`:238`) reads
`(g.viewMode || "detailed") !== "compact"` to early-return — since there is no longer a
detailed mode, that guard is now always false (always the compact path). You can leave the
line (harmless, `viewMode` is absent so it takes the compact branch) OR drop the early-return
and always run the translate path. Either is green; step 01 deletes the whole function anyway.
Do the minimal thing here.

`reorganize` (`:307-325`) reads `const mode = g.viewMode || "detailed"` at `:311` — with
`viewMode` gone from saves it resolves to `"detailed"`, which is *wrong* now (we want compact
gaps). But `reorganize` runs inside `applyDisplayUpdater` on `cx/cy`, still intact this step.
**Pin `mode` to `"compact"`** at `:311-316` so ✨ arrange uses compact sizes/gaps:

```ts
const rects = g.nodes.map((n) => {
  const s = measured.get(n.id) || estimateCardSize(n.type, "compact");
  ...
});
const pos = flowLayout(rects, rankedEdges(g), FLOW_GAPS["compact"]);
```

### 3. `minimizeCtx` — drop the toggle wiring

`:418-421` currently `{ minimized, toggle: toggleMinimize, mode: viewMode, rename: renameCard }`.
Both `toggle` and `mode` are gone. Slim it:

```ts
const minimizeCtx = useMemo(
  () => ({ minimized, rename: renameCard }),
  [minimized, renameCard]
);
```

## The UI deletions

### `nodes/NodeFrame.tsx`

- `:130` destructure `{ minimized: minSet, toggle, mode, rename }` → `{ minimized: minSet, rename }`.
- `:200-222` — **delete the entire ▢/– button block** (it is `toggle && node.type !== "output"`).
- `:145-150` — `stateMin`/`isMin`: `stateMin` was only the button's glyph state; with the
  button gone, keep just `const isMin = minimized ?? false;` (CompactCard passes
  `minimized={false}` so its preview body shows; output passes nothing). Remove the `mode`
  references in the deleted tooltip.
- Update `minimizeContext.ts` (`:8-16`) — drop `toggle` and `mode` from `MinimizeCtx`; keep
  `{ minimized?, rename? }`.

### `Palette.tsx`

- Remove `viewMode` / `onSetViewMode` props (`:23-24`, and the destructure ~`:69`).
- Delete the `.anim-viewmode` toggle block (`:294-314`).
- The ✨ arrange tooltip (`:285`) is worded per-mode — make it unconditionally the compact
  wording.

### `AnimationCanvas.tsx`

- Drop `viewMode` / `setViewMode` from the `useGraphEditor` destructure (`:63-65`).
- Remove the two Palette props `viewMode={viewMode}` / `onSetViewMode={…}` (`:146-147`).

## Tests

- `animationCanvas.dom.test.tsx:99-260` — the toggle and override cases no longer describe
  reality. Rewrite them toward the end-state invariant (see the README): a non-output card
  renders compact; clicking the (now absent) toggle is deleted; output renders full. The
  **position-drag** and **v16-migration** cases stay as-is — coords/schema are still intact.
- `animationNodes.test.ts:~28` — the `MinimizeContext` test provider value: trim to
  `{ minimized, rename }`.
- `montageShortfall.dom.test.tsx:114,123` — drop the `viewMode: "compact"` graph field from
  the fixtures (harmless now; removed from the type in step 01).

## Verification

1. `cd frontend && npx tsc --noEmit` — the type of `MinimizeCtx` changed; catch every reader.
2. `npm run test` — green. The still-present `graphEditorDisplay.test.ts` and v16 migration
   test must stay green (nothing about coordinates or schema moved yet).
3. `npm run lint`.
4. By hand (`make dev`): open any project → all non-output cards are compact, output is full,
   there is no detailed/compact toolbar toggle and no ▢/– on any card. Editing a card via its
   modal still works. ✨ arrange lays out with compact spacing.

## Acceptance

- No `.anim-viewmode` toggle, no ▢/– button anywhere.
- `renderAnimNode` branches on `node.type !== "output"` only.
- `minimizeCtx` carries `{ minimized, rename }`.
- Suite green **including** the untouched coordinate/migration tests.

## Risks

- **A stray `viewMode` reader.** `tsc` catches the typed ones; grep `viewMode`/`viewOverrides`
  for string-keyed access the compiler won't flag.
- **`reorganize` using detailed gaps.** The `mode` pin above is the fix — verify ✨ arrange
  visually, cards should sit at compact spacing, not detailed.
