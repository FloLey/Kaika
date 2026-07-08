# 03 — UX polish

> Four small, independent changes (one commit each) that make existing behaviour
> discoverable or consistent: undo/redo exists but is invisible; the export
> checklist names problems it won't take you to; two destructive actions still use
> `window.confirm`; the autosave-failure badge hides on the one stage where losing
> work hurts most.

## U1 — Visible undo/redo (commit 6)

### Current behaviour

Graph undo/redo fully works — `useGraphEditor.ts:120-162` + `lib/graph/history.ts`
(session-only, per-segment, 400 ms coalescing, 50-step cap) — but only via
Cmd/Ctrl+Z / Shift+Cmd/Ctrl+Z. There is no button, no tooltip mentions it, and
`useGraphEditor` doesn't even return the callbacks: they exist only inside the
keydown listener. Users won't discover the feature and get no enabled/disabled
feedback.

### Changes

1. **`useGraphEditor.ts`** — return `undo`, `redo`, `canUndo`, `canRedo` from the
   hook (the `return {...}` at ~:436). `canUndo =
   historyRef.current.past.length > 0` (same for `future`) is safe to read at
   render time even though `historyRef` is non-reactive: every history
   transition is accompanied by a `commitGraph` state update, so the component
   re-renders on each one.
2. **`AnimationCanvas.tsx`** — destructure the four and pass to `<Palette …>`.
3. **`Palette.tsx`** — new optional props `onUndo/onRedo/canUndo/canRedo`; render
   two `btn sm` buttons `↶` / `↷` next to `⊙ fit` (after the
   `anim-toolbar-spacer`, ~:201), `disabled={!canUndo}` / `{!canRedo}`, titles
   `"Undo (⌘Z)"` / `"Redo (⇧⌘Z)"`.
4. **`Docs.tsx`** — one sentence in the existing animation-toolbar prose (no new
   `DOC_SECTION_IDS` entry).

### Tests

`animationCanvas.dom.test.tsx`: both buttons disabled on a fresh graph; after a
mutation undo enables; clicking ↶ restores the prior graph and enables ↷.

## U2 — Export checklist click-through (commit 7)

### Current behaviour

`ExportStep.tsx:354-371` lists every segment and warns when one lacks a ★ final
output — but the row is inert. Fixing it means: leave Export, switch to Studio,
find the segment by name, mark an output. The animation palette's problems list
already does this right (`Palette.tsx:219-231` — each problem is a button that
jumps to the offending card); imitate it.

### Changes

1. **`ExportStep.tsx`** — new prop `onOpenSegment?: (segId: string) => void`.
   Unmarked checklist rows render as a button (or gain an inner "→ open in
   studio" button) calling it; marked rows stay non-interactive.
2. **`App.tsx`** (~:326, where `<ExportStep>` is rendered) —
   `onOpenSegment={(id) => { setActiveSegId(id); setStep("studio"); }}`.
   App already owns both (it passes them to Studio at ~:311-312); no new state.
3. **`Docs.tsx`** export section — one sentence: click a ⚠ row to jump to that
   segment.

### Tests

`exportStep.dom.test.tsx`: clicking an unmarked row fires `onOpenSegment` with
the segment id; a marked row does not.

## U3 — `ConfirmDialog` replaces `window.confirm` (commit 8)

### Current behaviour

Two destructive confirmations use the blocking native dialog, unstylable and
awkward to test: `window.confirm` in `Studio.tsx:198` (copy-layout would
overwrite the target segment's existing animation) and a bare `confirm(...)` in
`ProjectList.tsx:41` (delete a project — which is irreversible and removes
audio/stems/spectrograms). Everything else in
the app uses its own chrome. There is no reusable confirm component today
(`ui/` holds only `Ctl.tsx` and `Info.tsx`); the modal pattern to imitate is
`NodeSettingsModal.tsx` (`createPortal` into `lib/portalTarget.ts`).

### Changes

1. **New `frontend/src/ui/ConfirmDialog.tsx`** —
   `{ open, message, confirmLabel?, danger?, onConfirm, onCancel }`; portal into
   `portalTarget()`; overlay click and Escape cancel; autofocus the confirm
   button; `danger` styles the confirm button destructive-red. Reuse the
   existing `btn` styles + minimal CSS beside the modal styles.
2. **`Studio.tsx:198`** — replace `window.confirm` with pending-action state
   (`copyTarget: Segment | null`); the dialog's confirm runs the existing copy
   body.
3. **`ProjectList.tsx:41`** — same pattern (`pendingDelete: string | null`);
   confirm runs `deleteProject`. Message spells out what is deleted (matches the
   Docs' "cannot be undone" warning).

### Tests

New `frontend/src/__tests__/confirmDialog.dom.test.tsx`: confirm/cancel
callbacks fire; Escape cancels; nothing renders when `open` is false.

## U4 — saveError badge on the Export stage (commit 9)

### Current behaviour

Autosave runs on review, studio **and** export (`App.tsx:61`), but the "changes
not saved" badge renders only for `step === "review" || step === "studio"`
(`App.tsx:238`). An autosave failure while exporting is silent.

### Change

One line: include `step === "export"` in the badge condition.

### Tests

Existing App tests cover the badge; extend only if a stage-conditional test
already exists to copy.

## Verification

Per commit: `make test-frontend`, `npx tsc --noEmit`, `make lint`. Live pass
(`make dev`): undo buttons grey→active while editing a graph; a ⚠ export row
lands in the right segment's studio; both confirms show the styled dialog;
stopping Postgres mid-export-edit shows the badge.

## Out of scope

- Keyboard/ARIA accessibility for the graph canvas itself (edge ✕ focus, card
  roles) — real gap, separate wave; these four changes don't touch the canvas.
- Undo/redo for anything beyond the graph editor (segments, signals).
