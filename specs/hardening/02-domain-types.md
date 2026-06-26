# 02 — Centralize domain types + type the API layer

> The TS migration left the core domain types living inside components: `Segment`
> (`Studio.tsx`, redefined in `SegmentRail.tsx`), `Signal` (`SignalCard.tsx`), `StemInfo`
> (`Studio.tsx` and again in `SignalCard.tsx`). The animation layer reads segments through
> a separate loose `SignalDef`. Because the types aren't shared, **8 casts** paper over
> the seams (`as Segment[]` ×6, `as unknown as AnimSegment`, `as Signal`), and `api.ts`
> returns `Promise<any>` from all 13 endpoints, so call sites guess shapes. This lifts the
> domain types into `lib/types.ts`, unifies `SignalDef` with `Signal`, and types the API
> responses — deleting every cast and shrinking the `any` surface. Frontend-only; **no
> runtime behaviour change.**

## Locked decisions

1. **`lib/types.ts` is the home** for the shared domain types (it already holds the graph
   types — `GraphNode`, `Graph`, `OutputSettings`, `SignalData`, …). Add `Segment`,
   `Signal`, `StemInfo` there; components import them.
2. **One `Signal`, not two shapes.** `SignalDef` in `nodes/nodeProps.ts` (the loose
   `{ id, name?, stemKey?, feature?, [k]: unknown }` the cards read) becomes a type alias
   of / structural subset of the canonical `Signal`, so `Segment.signals: Signal[]` flows
   into the animation layer **without** the `Studio.tsx` `as unknown as AnimSegment` bridge.
3. **`hydrateSegments` returns `Segment[]`** (not `AnyRec[]`), typed via `Raw*` input
   interfaces describing the JSON it ingests — so the `as Segment[]` casts in `App.tsx`
   and `ReviewStep.tsx` disappear. The mutation helpers (`splitAt`/`moveBoundary`/
   `mergeWithPrev`) take and return `Segment[]`.
4. **Typed API responses.** Each `api.ts` export gets a response interface
   (`UploadResult`, `JobStatus`, `Project`, `SegmentProposal`, `ExtractResult`,
   `RenderResult`, …). `jsonOrThrow` stays `Promise<any>` (the genuine JSON boundary) and
   keeps its single disable; the **file-level** `no-explicit-any` disable is removed.
5. **No new validation/parsing at runtime.** Types are compile-time only; the backend
   contract is unchanged. Where the backend is genuinely dynamic, prefer `unknown` + a
   narrow over `any`.

## Architecture this builds on

- `lib/types.ts` — already exports `OutputSettings`, `Graph`, `GraphNode`, `SignalData`,
  `FluidData`, etc. The `OutputSettings` definition + its `withOutputDefaults` (in
  `lib/output.ts`) are the pattern to mirror for the new domain types.
- `components/studio/Studio.tsx` — `export interface Segment` (id/label/start/end/signals/
  graph?), local `type StemInfo`, the `AnimSegment` bridge + `as unknown as` cast (line
  ~277), and `as Signal` on `seedSignal` (line ~138).
- `components/studio/SignalCard.tsx` — `export interface Signal` (the concrete shape),
  local `interface StemInfo`.
- `components/studio/SegmentRail.tsx` — a second, minimal local `Segment` (id/label?/
  start/end). Replace with the canonical type (it's structurally a subset).
- `components/animation/nodes/nodeProps.ts` — `SignalDef` + `NodeCtx.segment` (the loose
  carrier). `NodeCtx` stays loose where cards read `ctx?.x` defensively; only the
  `signals` element type is unified.
- `lib/segments.ts` — `hydrateSegments`/`serializeSegments`/`splitAt`/`mergeWithPrev`/
  `moveBoundary`/`seedSignal`, currently `AnyRec`-typed behind a file-level `any` disable.
- `lib/api.ts` — 13 `Promise<any>` exports behind a file-level disable; consumers in
  `App.tsx`, `ProjectList.tsx`, `SignalCard.tsx`, `OutputNode.tsx`, `SignalNode.tsx`,
  `FluidLab.tsx`.
- **Depends on spec 01** so the now-real lint gate (`no-explicit-any` enforced) guards
  this refactor as the `any`s come out.

---

## Step 1 — Lift the domain types into `lib/types.ts`

**Goal.** One `Segment`, one `Signal`, one `StemInfo`, shared everywhere; the
component-to-animation cast removed.

**Files.** `lib/types.ts` (add the types), `components/studio/{Studio,SignalCard,
SegmentRail}.tsx`, `components/animation/nodes/nodeProps.ts`, plus importers
(`App.tsx`, `ReviewStep.tsx`).

**Design.**
- Move `Signal` (from `SignalCard.tsx`), `Segment` (from `Studio.tsx`), and `StemInfo`
  (the `{ sr?, spectrogram?, audio? }` shape, deduped from both Studio and SignalCard)
  into `lib/types.ts`. Re-export nothing from the old sites — update imports.
- Make `SignalDef` either `type SignalDef = Signal` or a documented structural subset, so
  `NodeCtx.segment.signals` is `Signal[]`. Then `Studio.tsx` passes `activeSeg` to
  `AnimationCanvas` with **no** `as unknown as AnimSegment` — drop the `AnimSegment` alias.
- `seedSignal` returns `Signal` (see Step 3), removing the `as Signal` at the `addSignal`
  call.

**Reuse.** The graph types already in `lib/types.ts`; `SegmentRail`'s local type is a
subset of the canonical `Segment` — delete it and import.

**Acceptance.** `Segment`/`Signal`/`StemInfo` are defined once (in `lib/types.ts`); the
`as unknown as AnimSegment` and `as Signal` casts are gone; `tsc` green.

**Verification (two-audience).** *Agent:* `grep -rn "as unknown as\|interface Segment\|interface StemInfo" src` shows only the `lib/types.ts` definitions and the legit `audio.ts` webkit cast; `npm run typecheck` + `lint` + `build` + `test` green. *User:* `make dev` → studio + animation editor still render and edit segments.

**Risks.** Unifying `SignalDef` could surface places where a card relied on the loose
index signature; keep the index signature on `Signal` only if a real consumer needs it
(prefer not to — see Step 3's `Raw*` types for the JSON edge).

---

## Step 2 — Type the `api.ts` response surface

**Goal.** Call sites know what each endpoint returns; the file-level `any` disable goes.

**Files.** `lib/api.ts`; touch-ups at consumers where a now-typed field is read.

**Design.** Define a response interface per endpoint and annotate the return type:
- `uploadSong`/`pollJob`(upload) → `UploadResult { job_id; title?; duration?; has_lyrics?; stems: Record<string, StemInfo> }`
- `getJob` → `JobStatus { state: "running"|"done"|"error"; step?; error?; result?: unknown }`
- `segmentJob`/`pollJob`(segment) → `SegmentProposal { segments: RawSegment[]; vocal_envelope?: number[]; envelope_times?: number[]; duration? }`
- `getProject` → `Project { job_id; title?; duration?; stems; segments; output?; vocal_envelope?; … }`; `listProjects` → `ProjectSummary[]`
- `extractSignal` → `ExtractResult { curve: number[]; times: number[] }`
- `runFluid`/`renderGraph` → `RenderResult { url: string }`

Keep `jsonOrThrow` as `Promise<any>` with a single inline disable (the real JSON
boundary). Remove the top-of-file `/* eslint-disable @typescript-eslint/no-explicit-any */`.

**Reuse.** `StemInfo` from Step 1; `RawSegment` from Step 3.

**Acceptance.** Every `api.ts` export has a typed return; no `Promise<any>` except inside
`jsonOrThrow`; the file-level disable is gone.

**Verification (two-audience).** *Agent:* `grep -c "Promise<any>" src/lib/api.ts` → 1 (just `jsonOrThrow`); `tsc` + `lint` green; consumers compile. *User:* upload → segment → studio → animate still works end-to-end (`make dev`).

**Risks.** Over-tightening a response that the backend returns loosely → a real runtime
shape the type forbids. Mark genuinely-optional fields optional; when unsure, `unknown` +
narrow at the call site beats a wrong concrete type.

---

## Step 3 — Type `segments.ts` so the hydration casts vanish

**Goal.** `hydrateSegments` returns `Segment[]`; `App.tsx`/`ReviewStep.tsx` stop casting.

**Files.** `lib/segments.ts`; remove `as Segment[]` at `App.tsx:110,132` and
`ReviewStep.tsx:79,88,150,236`.

**Design.** Introduce `RawSegment`/`RawSignal` interfaces describing the JSON shape the
backend sends (loose, optional fields), and type the public functions:
`hydrateSegments(raw: RawSegment[] | null, stems): Segment[]`, `serializeSegments(segs:
Segment[]): RawSegment[]`, `splitAt/moveBoundary/mergeWithPrev(segs: Segment[], …):
Segment[]`, `seedSignal(...): Signal`. Internal dynamic-key munging may keep a **narrowed**
`any`/`unknown` with a justified inline disable, but the **signatures** are concrete.
Remove the file-level `no-explicit-any` disable if the internals can be expressed without
broad `any`; otherwise keep it but scoped to the genuinely-dynamic helpers with a comment.

**Reuse.** `Segment`/`Signal` from Step 1; `RawSegment` shared with `api.ts` Step 2.

**Acceptance.** `hydrateSegments(...)` is assignable to `Segment[]` with no cast; the 6
`as Segment[]` casts are deleted; `tsc` + `lint` green.

**Verification (two-audience).** *Agent:* `grep -rn "as Segment\[\]" src` → empty; full
frontend gate (tsc/lint/test/build/format) green. *User:* review screen — split / merge /
move-boundary / relabel all still work; studio loads a resumed project's segments.

**Risks.** `serializeSegments` must keep emitting exactly the persisted JSON shape (App's
autosave compares `JSON.stringify`); don't let the typing change which fields are written.
The route smoke + a manual save/reload confirm parity.

---

## v1 boundary & extension points

**This spec:** the three domain types live once in `lib/types.ts`, the animation layer and
studio share `Signal`, the API layer and hydration are typed, and all 8 casts + the
file-level `any` in `api.ts` are gone. **Designed-for:** a future feature adds a field to
`Segment`/`Signal` in one place and the compiler shows every site that must handle it; a
new endpoint declares its response interface alongside the others. **Out of scope:**
runtime schema validation (e.g. zod) of API responses — the types are compile-time; add a
validator only if backend drift becomes a real problem.
