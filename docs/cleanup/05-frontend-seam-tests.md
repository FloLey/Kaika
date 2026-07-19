# Step 05 — Frontend seam tests

**Goal.** Cover the frontend logic that decides *correctness* before steps 11–13 restructure
it.

**Blocked by.** Steps 02, 03 — **and the uncommitted working tree must land or be abandoned
first.**

**Gates.** Step 12's `useJobRun` extraction and the OutputNode↔StreamPreview merge are
unsafe until this lands.

> Line numbers are a snapshot — re-grep before relying on one.

---

## ⚠ Collision warning

At the time this plan was written the working tree had uncommitted changes in:

```
frontend/src/lib/graph/layout.ts
frontend/src/lib/graph/mutations.ts
frontend/src/lib/graphModel.ts
frontend/src/components/animation/useGraphEditor.ts
frontend/src/__tests__/layout.test.ts
```

Steps 05, 11, 12 and 13 all re-enter those files. Do not start this step while that work is
in flight. Steps 02–04 and 06–10 are backend/CI-only and are collision-free — that is the
main argument for doing the backend half of this plan first.

---

## What to cover

### 1. `lib/graph/ports.ts` (54 lines, zero tests) — highest value per line

`canConnect` / `connectIssue` decide which wires are **legal**. The file's own comment says
the two must stay "in lockstep" — exactly the invariant a test should pin, and exactly the
kind that rots quietly. Both are pure functions, so this is cheap: a table of
(source type, source port, target type, target port) → expected verdict, including the
`connectIssue` message, so the lockstep is asserted rather than hoped for.

Cover the **loose-edge** case explicitly (`targetPort: "__in"`, no binding). `CLAUDE.md:44`
names it a hard invariant — parked wires must be filtered out of every hash and validate on
both sides — and it is precisely the case a table test would otherwise skip.

### 2. `useGraphEditor.ts` (479 lines, zero tests) — the editor brain

Reached today only indirectly, via `graphCanvas.dom.test.tsx`. Four concerns worth a unit
test each:

- **undo/redo coalescing** (`:141-163`)
- **the compact `cx/cy` display-space round-trip** (`:205-224`) — subtle identity-preserving
  logic built on a `WeakMap`; the kind of code that breaks without any visible symptom
- **`layoutForMode` mode-switch derivation** (`:59-77`)
- **connect-routing rules** (`:296-331`) — note this is the code step 11 pulls into
  `connectByKind` / `disconnectEdge` helpers, so test the behaviour, not the shape

### 3. `App.tsx` autosave supersede logic (`:72-96`, `:105-118`)

The autosave promise chain and `saveLyricLines`'s chain-splice. Out-of-order commits are the
*stated* failure mode and nothing tests it. Simulate a slow save resolving after a fast one
and assert the newer state wins.

### 4. The three job hooks — `useRenderJob.ts` (136), `useAssetUpload.ts` (68), `useStudioPlayback.ts` (185)

All zero-coverage, all replaced or rewired by step 12's `useJobRun`.

- `useRenderJob` — HD/export lifecycle, currently exercised only incidentally through
  `exportStep.dom.test.tsx`.
- `useAssetUpload` — the upload and YouTube-import **error** paths, used by 4 cards.
- `useStudioPlayback` — the transport/clock/solo registry. `syncedPlayback.dom.test.tsx`
  covers the *card* side, not this.

Pin abort behaviour in particular: all three swallow `AbortError`, and step 12 folds that
into one place. If the three currently disagree about what happens after an abort, record
which one is right *here*, before the merge picks arbitrarily.

---

## Acceptance criteria

1. Break one rule in `canConnect` without touching `connectIssue` → the lockstep test goes red.
2. Wire a loose edge into a graph hash → the invariant test goes red.
3. Resolve two autosaves out of order → the supersede test goes red if the guard is removed.
4. Make `useAssetUpload` rethrow on abort → its test goes red.

## Risks

- **`useGraphEditor` may resist unit testing** because of how much context it takes. If so,
  that is step 11's `Pick<NodeCtx, …>` finding arriving early — prefer testing the extracted
  pure pieces over building an elaborate harness around the whole hook.
- **Testing hooks before refactoring them means rewriting some tests in step 12.** Accepted:
  a test you rewrite is still a test that caught the difference.
