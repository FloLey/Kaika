# Step 13 — Frontend splits

**Goal.** Break the four oversized components, now that the shared pieces live elsewhere.

**Blocked by.** Step 05 (`ports.ts`, `useGraphEditor` coverage), step 12.

**Why last.** Splitting before step 12 relocates duplication into new files instead of
removing it, and then every extracted piece needs a second pass.

> Line numbers are a snapshot — re-grep before relying on one.

---

## Start with `Docs.tsx` — big, boring, and obviously green

1521 lines, one function, one static JSX tree of 10 top-level `<section>`s. It has no
blockers of its own and is pure mechanical relocation, so it opens the step with a diff
nobody has to think hard about.

Split into `components/docs/`:

- a thin `Docs.tsx` shell keeping `DOC_SECTION_IDS` (`:7-33`) and the scroll effect (`:42-47`)
- `GettingStarted.tsx` (`:102-135`), `Projects.tsx` (`:136-168`), `Upload.tsx` (`:169-244`),
  `Review.tsx` (`:245-317`), `Studio.tsx` (`:318-485`)
- `animation/` — `:486-1292` is ~800 lines alone: `Cards.tsx` (`:499-705`),
  `Modulators.tsx` (`:706-772`), `Points.tsx` (`:773-814`), `Sources.tsx` (`:815-942`),
  `Generators.tsx` (`:943-1017`), `Fx.tsx` (`:1008-1201`), `Rendering.tsx` (`:1202-1292`)
- `Export.tsx` (`:1293-1336`), `Settings.tsx` (`:1337-1369`), `FluidLab.tsx` (`:1370-1480`),
  `Tips.tsx` (`:1481-…`)

`paramHelp.test.tsx` already guards the id set bidirectionally, so a lost or renamed anchor
goes red. Keep the ids identical — they are live URLs (`/?doc=<section>`) that every "?" in
the UI deep-links into.

## `GraphCanvas.tsx` (736)

The substantive one. Three **near-identical window-pointer gesture blocks** — node drag
(`:313-348`), wire connect (`:397-454`), marquee (`:476-507`) — each of the form
`useEffect(() => { const move=…; const up=…; addEventListener×2; return removeEventListener×2 }, [...])`.

- Extract `useWindowPointer(active, { onMove, onUp })` and use it 3×
- Then `useNodeDrag`, `useWireConnect`, `useMarquee` into `components/animation/canvas/`
- Extract the edge geometry + SVG (`:567-585`, `:625-660`) into
  `<EdgeLayer edges selected onSelect onDelete />`
- Move `DragItem`/`Drag` (`:256-270`), `Wire` (`:351-358`), `Marquee` (`:457-462`) out of the
  component body to module scope

Leaves ~250 lines of composition. `graphCanvas.dom.test.tsx` and step 05's `useGraphEditor`
tests are the net here; drag/marquee behaviour is easy to break in ways types cannot see, so
click-test each gesture.

## `Studio.tsx` (495)

- `:85-95` fullscreen → `useFullscreen(ref)`
- `:137-194` — `editActiveSignals` / `updateSignal` / `addSignal` / `removeSignal` /
  `setActiveGraph` / `setFinalOutput` are all the same
  `prev.map(s => s.id === activeSegId ? … : s)` → `useSegmentEdits(setSegments, activeSegId)`
- `:196-258` copy-layout + `copyTarget` confirm → `useCopyLayout(...)`
- `:289-370` header/transport → `<StudioHeader>`
- `:372-420` signals tab → `<SignalsTab>`
- `:223-246` `dropAssetCard` mutates a graph inside a component — move it next to
  `addAssetCard` in `lib/graph/mutations.ts`, per `CLAUDE.md:43`

## `App.tsx` (403)

Twelve `useState`s all describing one project and all set together in `openProject`
(`:199-242`). Extract `useProject()` returning `{ project, load, reset }`, or a `useReducer`.

Also: the autosave payload literal
`{ step, segments: serializeSegments(segments), output, export: exportSettings }` is written
three times (`:76`, `:108`, `:126`) → one `buildSavePayload()`. Step 05 tests the supersede
logic that lives right next to it — keep those tests green through the extraction.

## The prop-drilling, if there is appetite

`stems, job, output, exportSettings, assets, lyricLines, onSaveLyricLines, groupClock,
groupPlaying` pass unchanged through **three** layers: `Studio.tsx:422-439` →
`AnimationCanvas.tsx:13-29 & 75-88` (declared as props *and* re-listed as hook opts) →
`useGraphEditor.ts:79-95` → `ctx` at `:412-454`. The same nine names, written five times.

A `ProjectContext` provided in `App` and consumed by `useGraphEditor` removes ~40 lines of
pure pass-through and shrinks the 15-entry dep array at `useGraphEditor.ts:435-453`.

Related and cheaper: `GraphEditorOpts` (`useGraphEditor.ts:79-92`) duplicates `NodeCtx`
field-by-field and half-admits it (`stems?: NodeCtx["stems"]`, `job?: NodeCtx["job"]`, …).
Replace with `Pick<NodeCtx, "stems" | "job" | "output" | …> & { segment; commitGraph }`.

**This is the most optional item in the plan.** Do the `Pick<>` (S, obvious win); treat the
context as a judgement call — a context that hides real data flow is not automatically
better than explicit props.

---

## Acceptance criteria

1. Every `/?doc=<section>` anchor still resolves — `paramHelp.test.tsx` plus a manual pass
   through the in-app guide.
2. All three canvas gestures work by hand: drag a node, draw a wire, marquee-select.
   Then delete a selection and confirm the keydown fix from step 12 held.
3. Step 05's `useGraphEditor` and `App` autosave tests green throughout.
4. `npm run build` succeeds — the new directory structure is the kind of change that breaks
   a lazy import path without failing `tsc`.

## Risks

- **`Docs.tsx` anchor loss.** Guarded, but keep the split mechanical: move JSX, don't reword
  prose. Prose changes belong in step 14.
- **Gesture regressions are invisible to the suite.** `useWindowPointer` is a genuine
  behaviour-carrying extraction (listener lifetimes, cleanup order). Land it as its own
  commit, before the three hooks that use it.
