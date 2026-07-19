# Step 12 — Frontend primitives: extract before splitting

**Goal.** One implementation of each thing currently copy-pasted across cards and modals.

**Blocked by.** Step 05 (**hard** for the job hooks), step 11.

**Why before the splits.** Splitting components first *relocates* the duplicated blocks into
new files and forces a second pass over every one of them. Extract, then split.

> Line numbers are a snapshot — re-grep before relying on one.

---

## Context: the card layer is mostly fine

Worth stating so this step doesn't turn into a rewrite. `makeGenSourceNode` (6 sim cards at
13–16 lines each), `AssetLayerCard` (Image/Video) and `useNodeData` already do their job, and
no card diverges from `NodeFrame` / `CompactPreview` without cause. The structural outlier is
`OutputNode`, and its divergence is the one that is unjustified.

---

## 1. `useJobRun` — job-poll boilerplate in four places

`ImagegenNode.tsx:92-100` and `StylizeNode.tsx:58-64` each declare an identical `pollAbort`
ref + unmount-abort effect + `const isAbort = (ex) => ex instanceof DOMException && ex.name
=== "AbortError"` + the same `setBusy`/`setErr`/`try`/`catch(isAbort)`/`finally` shape.
`useAssetUpload.ts:23-64` is a third variant. `AssetLibrary.tsx:95-110+` is a fourth — it
duplicates `useAssetUpload` wholesale with its own `uploadAsset` / `assetFromYoutube` /
`pollJob`.

One `useJobRun<T>()` in `lib/`, returning `{ busy, err, run(startFn) }` with the abort
controller and abort-swallowing built in. `useAssetUpload` and `AssetLibrary` then share one
upload path.

**⚠ Unsafe before step 05.** All three job hooks have zero coverage today. Step 05 also
records whether they currently *disagree* about post-abort behaviour — if they do, decide
deliberately here rather than letting the merge pick.

## 2. `OutputNode` re-implements `StreamPreview` — and they have already drifted

`OutputNode.tsx:55-73` (the renderKey memo) is character-for-character
`StreamPreview.tsx:29-37`. `OutputNode.tsx:94-96` == `StreamPreview.tsx:75-77`.
`OutputNode.tsx:228-274` (the `anim-output-well` + `<video>` + busy/progress/error markup)
== `StreamPreview.tsx:81-116`. The only genuine differences are the empty-state text and the
click-to-open badge.

**They have already drifted:** `OutputNode` calls `resetPlayback()` on key change
(`:87-89`); `StreamPreview` does not.

Extract `useRenderKey(ctx, nodeId)` and a presentational
`<RenderWell videoUrl busy error progress aspect compact emptySlot>`. OutputNode keeps only
the final-output / HD logic. ~90 lines out.

**Do not let the merge pick the behaviour.** Decide whether resetting playback on key change
is right, write the test for that decision, *then* merge. This is the single place in the
frontend half of the plan where "make them one" can silently change what users see.

## 3. The cheap dedupes

- **`ParamRows`** — this 8-line block is verbatim in **10** cards (`AssetLayerCard.tsx:140`,
  `BackdropNode.tsx:47`, `ColorGradeNode.tsx:163`, `EchoNode.tsx:95`, `GenSourceNode.tsx:126`,
  `LyricsNode`, `MontageNode`, `SlideshowNode`, `StylizeNode`, `TransformNode`):

  ```tsx
  {XXX_PARAMS.map((p) => (
    <ParamRow key={p.key} node={node} param={p} helpers={helpers}
      onGraphChange={onGraphChange} onDetach={(key) => onDetach?.(node.id, key)} />
  ))}
  ```

  Add `<ParamRows params={X} … />` to `FluidParamRow.tsx`; each card becomes one line. ~70
  lines out, and it removes the `onDetach?.(node.id, key)` re-binding that is easy to get
  wrong on a new card.

- **One `jobIdOf`** — defined twice, **divergently**: `nodeProps.ts:68` handles `job_id`
  only; `useAssetUpload.ts:8` handles `job_id` **and** `jobId`. Consumers are split between
  them (`useResolvedCurve.ts:3`, `useResolvedPoints.ts:3`, `OutputNode.tsx:14`,
  `ImagegenNode.tsx:12`, `StylizeNode.tsx:13` vs `useAssetUpload.ts:20`). Keep the more
  permissive behaviour, delete the other, re-export from one place.

- **One aspect helper** — `ctx?.output ? aspectOf(ctx.output) : "1 / 1"` appears 8×
  (`ColorGradeNode:75`, `EchoNode:68`, `ExtractNode:62`, `MontageNode:191`, `StylizeNode:150`,
  `TransformNode:71`, `CompactPreview:66`, `CompactPreview:129`). `StreamPreview` already
  receives `ctx` — let it derive `aspect` itself and make the prop an override. Six call
  sites collapse to `<StreamPreview node={node} ctx={ctx} />`.

- **`useEscapeKey`** — the same effect appears 9× (`ConfirmDialog:35`, `SettingsModal:26`,
  `VolumeControl:21`, `HdViewerModal:25`, `NodeSettingsModal:65`, `OutputSettings:44`,
  `LyricsEditor:19`, `ImagegenGallery:17`, `AssetLibrary:117`). Six of those also hand-roll
  `createPortal` + scrim, so a `<Modal>` shell absorbing portal + ESC + scrim +
  wheel-stopPropagation is the fuller version. Do `useEscapeKey` first (S), `<Modal>` second
  (M) — the second is a visual change and wants its own commit.

- **`<InlineRename value onCommit className>`** — `NodeFrame.tsx:139-201` and
  `NodeSettingsModal.tsx:144-165` implement the same `editing`/`draft`/`startEdit`/
  `commitEdit` + input-or-span pair.

## 4. Two mutation helpers that remove four copies of the same branch

`useGraphEditor.ts` does `const tgt = g.nodes.find(...); if (tgt && nodeParam(tgt.type, port))
… else …` four times: `:303-307`, `:325-327`, `:336-340`, `:362-367`.

Add `connectByKind(g, srcId, srcPort, tgtId, tgtPort)` and `disconnectEdge(g, edge)` to
`lib/graph/mutations.ts`. **Note `CLAUDE.md:43`**: ports may only be wired/unwired through
those helpers, and loose edges (`targetPort: "__in"`, no binding) must keep being filtered
out of every hash and validate. This change moves code *toward* that invariant, which is the
argument for doing it — but it touches exactly the file the uncommitted tree also touches.

## 5. Two state fixes worth taking here

- **`GraphCanvas.tsx:547-565`** — `onEdgeDelete`/`onDeleteSelection` are read through refs
  (`:533-536`) specifically to avoid re-subscribing, but `selected` is a raw dep, so the
  keydown listener is torn down and re-added on **every selection change** anyway. Use
  `selectedRef.current` (already maintained at `:95-96`) and drop the dep.
- **`ImagegenNode.tsx:68-83`** — two effects with suppressed dep arrays that write
  `prompts`/`activeCount` back into the graph in response to `needed`. The comments explain
  *why* the deps are suppressed, but the real shape is "derive `visiblePrompts` at render,
  persist only on user action". This is the most fragile hook in the codebase — a `set()`
  inside an effect keyed on a value derived from a network fetch. Fix it here **or**
  explicitly defer it with a note; do not leave it unexamined.

---

## Acceptance criteria

1. Step 05's hook tests green after `useJobRun` replaces all four copies.
2. The OutputNode↔StreamPreview decision has a test naming the chosen playback behaviour.
3. `grep -c "aspectOf(ctx.output)"` and the ESC-effect grep both drop to 1.
4. Click through every card in the Playground (`make seed-playground`) — `ParamRows` touches
   10 of them, and a wrong `onDetach` binding is invisible to the type checker.

## Risks

- **`<Modal>` changes stacking/scrim behaviour** in a way tests won't catch. Its own commit,
  and click through all six dialogs.
- **`connectByKind` collides with the uncommitted `mutations.ts` work.** Confirmed
  prerequisite: that tree lands first (see step 05).
