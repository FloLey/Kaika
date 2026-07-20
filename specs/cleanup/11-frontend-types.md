# Step 11 — Frontend types: eradicate `unknown`

**Goal.** Close the type holes before steps 12–13 extract hooks that would bake them into
new APIs.

**Blocked by.** Step 05.

**Why first among the frontend steps.** Extracting `useJobRun` (step 12) while `job` is
`unknown` ships the cast *into the new hook's signature*, and you touch every call site
twice. Types → primitives → splits, firmly, never the reverse.

> Line numbers are a snapshot — re-grep before relying on one.

---

## 1. `graph: Graph | unknown` — a real bug, not a style nit

`api.ts:302` and `api.ts:317`. `Graph | unknown` **collapses to `unknown`**: the `Graph`
contributes exactly nothing while reading as though it does. Every call site is unchecked
and looks checked.

Change to `Graph`. Same file: `output_id?: unknown` (`:304`, `:318`) → `string`.

## 2. `ctx.job?: unknown` — the cast that reaches the wire

`nodeProps.ts:36`. The consequence is `job as string` at `StreamPreview.tsx:32`,
`OutputNode.tsx:61`, and — the bad one — **`useStreamRender.ts:158`**, where
`job_id: job as string` is passed straight to the API. If `job` is ever the object form,
that sends an object as a job id.

Type it `string | { job_id: string }` and route every read through the single `jobIdOf`
(step 12 unifies the two divergent copies; this step gives it a type worth having).

## 3. `lyricLines?: unknown[]` threaded through six modules

`App.tsx:41`, `Studio.tsx:38-39`, `AnimationCanvas.tsx:20`, `useGraphEditor.ts:86`,
`nodeProps.ts:47`, `api.ts:29,63`. The shape is already documented — in a *comment* at
`nodeProps.ts:47`: `[{t0, t1, text}]`.

```ts
export interface LyricLine { t0: number; t1: number; text: string }
```

in `types.ts`, used in all seven places.

**⚠ Tripwire:** if this changes what `normalizeGraph` persists, it needs a `GRAPH_VERSION`
bump and a migration (`CLAUDE.md:47`). It almost certainly does not — lyric lines are
project state, not graph state — but check before committing rather than after.

## 4. Casts and aliases that subtract information

- **`NodeFrame.tsx:130-135`** casts `useContext(MinimizeContext)` to a shape where
  `minimized` and `toggle` are *optional* — but `MinimizeCtx` (`minimizeContext.ts:8-16`)
  already types them as **required**. The cast is why line `154` needs the paranoid
  `minSet && minSet.has && minSet.has(node.id)`. Drop the cast; line 154 becomes
  `minSet.has(node.id)`.
- **`nodeProps.ts:35`** `stems?: Record<string, unknown>` while `Studio.tsx:30` correctly has
  `Record<string, StemInfo>`. Use `StemInfo`.
- **`nodeProps.ts:26`** `export type SignalDef = Signal` — the comment admits it is "the
  canonical `Signal`". Delete the alias.

## 5. Six identical generative-source interfaces

`types.ts:269-298` — `WavesData` … `CloudsData` differ **only** in the `palette` literal
union:

```ts
interface GenSourceData<P extends string> { palette: P; seed: number; ports: Record<string, FluidPort> }
type WavesData = GenSourceData<"ocean" | "tropical" | "storm" | "sunset">
```

## 6. Loose string unions with the type in a comment

- `App.tsx:22` — `useState("projects")` with the union written in a comment on line 21,
  compared by string literal at `:75, 284, 292, 316`. Declare `type Step`. While there,
  `step === "review" || step === "studio" || step === "export"` appears three times → a
  `const EDITING_STEPS: ReadonlySet<Step>`.
- `Studio.tsx:76` — same pattern, `// "signals" | "animation"`. Declare `type StudioTab`.
- `Studio.tsx:36, 37, 46` use inline `import("../../lib/export").ExportSettings` in a props
  interface while lines 11 and 17-23 use normal `import type`. Move them up.

## 7. Dead code

- **`GraphCanvas.tsx:589-595`** — `helpers.onMove` is built and memoized into the helper bag
  and **nothing consumes it**. It is not in `NodeHelpers` (`nodeProps.ts:17-23`) and no card
  uses it (the other `onMove` hits are `useDragPad`'s unrelated handler). Delete it and the
  `onGraphChange` dep it drags into the memo.
- **`api.ts:291-307`** `renderGraph` + **`api.ts:72-74`** `RenderResult` — zero importers,
  superseded by `startStreamRender`.
- **`AnimationCanvas.tsx:120-121`** — a two-line comment describing code that no longer
  exists there. **`useGraphEditor.ts:375-377`**, **`api.ts:289-290`** — stray blank runs.
- **`types.ts:634`** — the comment says `NodeData<"fluid"> = FluidData`, but the type below
  is named `NodeOf` and resolves to the **node**, not the data. Fix the comment or add the
  `NodeData<T>` it describes.

---

## Acceptance criteria

1. `npx tsc --noEmit` green with **no** new `any` or `as` introduced — grep the diff for both.
2. Pass an object as `job` to `useStreamRender` → the type now rejects it at compile time.
3. Step 05's tests stay green (this step changes no runtime behaviour except where a cast
   was masking a bug — if a test goes red, that is a finding, not a regression to paper over).

## Risks

- **Tightening `graph: Graph` surfaces call sites that were genuinely passing something
  else.** Likely, and the entire point. Fix the call site; do not widen the type back.
- **`LyricLine` may not match reality** if some code path produces a fourth field. Grep for
  producers before declaring the interface, and prefer a slightly wider type over a
  confident wrong one.
