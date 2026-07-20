# Step 24 — Frontend dead code and drifted twins

**Status: PARTLY DONE** — `66a842e`. Deleted: `PortConnections.tsx`, `MiniSpark.tsx`,
`slideshowUrls`, `hasParams`, `RenderJobState` (a stale *partial* duplicate of a shape
TypeScript already infers — 7 of the hook's 10 fields). `NodeOf<T>` **kept**, now with a
comment saying why: deleting an unused type saves nothing at runtime and costs the next
person the derivation, unlike an unused component.

**Now DONE** — `254c268`, `a1cb81b`:
- `CompactCard.inFlow` defers to `cardInputs`. Not cosmetic: GraphCanvas validates a wire
  drop by flow, so a stale literal silently refuses a legal wire.
- One `STUB_HELPERS`, beside the interface. The two copies were identical *except* one was
  `as unknown as NodeHelpers` — which is precisely why one definition matters: a new
  required member breaks the typed copy at compile time and the cast copy at runtime.
- `validate()` **kept**, with the decision written into the file: it mirrors the backend's
  enforcing copy, the UI never needs it (the backend 400s), and ⚠ nothing keeps the two in
  sync — its own test asserts against itself, so a backend rule change leaves it quietly
  wrong and green.

**Tier.** Optional. Nothing depends on it; it is a clean, self-contained deletion pass.

**Goal.** Delete what nothing imports, and collapse two places where the same fact is encoded
twice.

**Blocked by.** Nothing.

**Size.** S.

> Every "unreferenced" claim below was verified by grep at audit time (2026-07-20).
> **Re-verify before deleting** — a new caller may have landed.

---

## 1. Two whole files nothing imports

### `components/animation/PortConnections.tsx` — 100 lines

Zero importers. It is an older, param-only version of `InputPicker.tsx`: same "INPUTS"
header, same `srcLabel`, same loose-wire optgroup, same `assignEdge`/`unassignEdge` picker.

This is the more interesting of the two deletions, because it is a **drifted twin, not just
dead code**. It encodes the binding↔edge protocol — which `CLAUDE.md` names a hard invariant
— and it encodes an older version of it. Anyone who finds it and reads it for reference
learns the wrong protocol. That is worse than dead weight.

### `components/animation/nodes/MiniSpark.tsx` — 31 lines

Zero importers. No subtlety; delete.

## 2. Dead exports

| Symbol | Site |
|---|---|
| `NodeOf<T>` | `lib/types.ts:629` |
| `slideshowUrls()` | `lib/imageCount.ts:42` |
| `hasParams()` | `lib/nodeParams.ts:77` |
| `RenderJobState` | `lib/useRenderJob.ts:17` |

⚠ **`NodeOf<T>` is a special case — do not delete it without reading step 24's note below.**
It has zero references, but it is the *tool for a fix that never happened*: ~34 sites do
`const d = node.data as FluidData` because `NodeProps` types `node` as a plain `GraphNode`
(`nodeProps.ts:83`), discarding the discriminated union at the door. `NodeOf<T>` is exactly
what would type those properly.

So the choice is: delete it as dead, or keep it and schedule the typing work. **Recommendation:
keep it, with a comment saying what it is for and that it is currently unused.** An unused type
costs nothing at runtime; re-deriving the idea later costs more. If the typing work is
explicitly not going to happen, then delete it — but make that a decision, not an oversight.

(The full typing change — making `NodeSpec` generic so `Component` is
`ComponentType<NodeProps<T>>` — is a wide mechanical diff across 30+ card files. It is not in
wave 3. If it is ever scheduled, it is its own step.)

## 3. `validate()` — alive only through its own test

`lib/graph/validate.ts:171`. **No production caller**; the only reference is
`__tests__/graphModel.test.ts`. ~40 lines kept alive by the test that tests it.

Two legitimate readings, and the point of this item is to pick one:

- It is a **deliberate mirror** of the backend's validation contract, kept so the frontend can
  catch problems without a round-trip. Wave-1 step 4 explicitly discussed trimming the
  frontend mirror to "cycles, slot ids, renderability" and leaving the server authoritative
  for the rest. If this is a survivor of that trim → **keep it, and write the comment saying
  so**, because right now nothing records the intent.
- It is a leftover from before the trim → delete it and its test.

Check git history on the file before deciding. Do not guess.

## 4. `CompactCard.inFlow` re-derives what `cardInputs` already declares

`nodes/CompactCard.tsx:31-44` hardcodes the port→flow relation with string literals:
`positions → points`, `fillColor|outlineColor|tint → color`, else video-by-inspection.

`nodeInputs.ts:60-185` (`cardInputs`) is the declared single source of truth for exactly this
— per type, per port, with a `flow` field.

Two encodings of one relation, and the comment at `CompactCard.tsx:28-31` already notes the
consequence of getting it wrong: a wrong flow makes `canConnect` reject a legal wire. Replace
`inFlow` with a lookup into `cardInputs(node)`. That also makes a newly added card's compact
anchors correct for free, instead of requiring a second edit someone will forget.

This is the same class of finding wave 2 spent step 08 on (hand-mirrored tables), one level
down.

## 5. `STUB_HELPERS` / `NOOP_HELPERS` — the same no-op bag, twice

`NodeSettingsModal.tsx:32` (properly typed `NodeHelpers`) and `InputPicker.tsx:27-32`
(`as unknown as NodeHelpers`). Adjacent files, same purpose. Export the typed one; delete the
cast.

The cast is the part that matters — `as unknown as` defeats the type system entirely, so if
`NodeHelpers` gains a member, that site keeps compiling and fails at runtime.

---

## Verification

1. `npx tsc --noEmit` — the compiler is the primary check for deletions.
2. `make test` (vitest) — the wave-2 seam tests cover the wiring paths item 4 touches.
3. For item 4 specifically: **wire a `positions` port and a `tint` port in the compact view**
   and confirm both still connect. `canConnect` rejecting a legal wire is a silent UX failure
   that no test currently catches; check it by hand.
4. `grep` each deleted symbol across the tree, including tests, before deleting.

## Acceptance criteria

- `PortConnections.tsx` and `MiniSpark.tsx` gone.
- The dead exports gone, **or** kept with a comment recording why (`NodeOf`, possibly
  `validate`).
- One encoding of port→flow.
- No `as unknown as NodeHelpers` in the tree.

## Risks

- **Deleting `validate()` when it was a deliberate contract mirror.** Read the history first.
- **Item 4 changing behaviour.** The two encodings may not actually agree today — if
  `cardInputs` and `inFlow` disagree for some port, swapping to `cardInputs` *changes* what
  connects. That is presumably a bug fix, but find out which ports differ before assuming it,
  and mention them in the commit.
