# 01 — Finish the TypeScript migration

> The TS foundation shipped (`tsconfig`, `tsc` in CI, `types.ts` discriminated union,
> `graphModel.ts`, `registry.ts`, `useGraphEditor.ts`, `output.ts`, `useDragPad.ts`).
> The animation node cards + canvas/studio shells are still `.jsx`, so `NodeSpec.
> Component` is stuck at `ComponentType<any>`. This finishes the migration
> **leaf-outward**, one file at a time, ending green each step — then tightens the
> registry to the real `NodeProps`. No behaviour change. No code until its step.

## Locked decisions

1. **Leaf-outward, one file per commit-able step.** Cards before shells; each file
   converts + verifies green (tsc + lint + 72 vitest + build) before the next. The
   migration is already proven this way (`output.ts` → `graphModel.ts` → `registry.ts`).
2. **Extensionless imports for converted files.** Rollup (production build) will NOT
   resolve a `"./Foo.js"` specifier to `Foo.tsx`; it resolves extensionless. So when a
   file becomes `.tsx`, every importer's specifier drops the extension (`"./Foo.jsx"`
   → `"./Foo"`). Vite/vitest resolve both; only rollup is strict.
3. **Type props against `NodeProps`** (already defined in `registry.ts`). Cards adopt
   it; once all cards are typed, `NodeSpec.Component` tightens from `any` to
   `ComponentType<NodeProps>` — the payoff that makes a malformed card a compile error.
4. **Scope = the animation editor + studio/fluid shells.** The app-shell / upload /
   review / `Docs` / `ProjectList` / `ui/*` components are an **optional final sweep**
   (step 5), not required for the registry tightening.

## Architecture this builds on

- `tsconfig.json`: `allowJs: true`, `checkJs: false`, `strict: true`, `noEmit`,
  `moduleResolution: "bundler"`, `jsx: "react-jsx"`. `.js`/`.jsx` and `.ts`/`.tsx`
  coexist; only `.ts(x)` are type-checked. `npm run typecheck` = `tsc --noEmit`, gated
  in CI.
- `lib/types.ts`: the discriminated `GraphNode` union + per-node `*Data` shapes,
  `Graph`, `GraphEdge`, `Binding`, `PortFlow`, `OutputSettings`, `FluidParam`,
  `ValidationResult`.
- `registry.ts`: `NodeProps` (the card contract) + `NodeSpec.Component:
  ComponentType<any>  // eslint-disable @typescript-eslint/no-explicit-any`.
- Untyped `.js` imports (e.g. `fluidParams.js`, `Ctl.jsx`) appear as inferred/`any`
  to `.tsx` consumers — fine; cast at the boundary as `graphModel.ts` did with
  `FLUID_PARAMS as FluidParam[]`.

## Inventory (verified against the tree)

Remaining `.jsx` in scope, grouped by step:
- **Cards (step 1):** `nodes/SignalNode`, `FluidNode`, `OutputNode`, `CombineNode`,
  `PointsNode`, `MinimizedCard`, `NodeFrame`, `FluidParamRow`.
- **Canvas shells (step 3):** `GraphCanvas`, `AnimationCanvas`, `Palette`,
  `renderAnimNode`, `usePanZoom.js`, `ports.js`, `nodes/fluidBindings.js`,
  `OutputSettings`.
- **Studio/fluid shells (step 4, with spec 02):** `studio/Studio`, `fluid/FluidLab`,
  `studio/PulsePad`, `SignalCard`, `CurveView`, `SegmentRail`, `Spectrogram`,
  `VolumeControl`.
- **Optional sweep (step 5):** `App`, `main`, `Docs`, `ErrorToast`, `LogsPanel`,
  `Processing`, `ProjectList`, `review/ReviewStep`, `upload/*`, `ui/Ctl`, `ui/Info`.

---

## Step 1 — Node cards → `.tsx`, adopting `NodeProps`

**Goal.** Convert the 8 card components; each typed against `NodeProps` (or its own
narrower props for the helpers `NodeFrame`/`FluidParamRow`).

**Files.** `components/animation/nodes/*.jsx` → `.tsx`; their importers
(`renderAnimNode`, `registry.ts`, `MinimizedCard`, the `__tests__/*`) lose the `.jsx`
extension on these specifiers. `nodes/fluidBindings.js` → `.ts` (pure helpers used by
`FluidNode`/`FluidParamRow`).

**Design.**
- Per card: `git mv X.jsx X.tsx`; type the props param as `NodeProps` (cards) or a
  local interface (`NodeFrame`, `Port`, `FluidParamRow`, `MultiAnchor`). Narrow
  `node` by `node.type === "fluid"` where the card needs `node.data.ports` etc. — the
  discriminated union then checks the access.
- `registry.ts` imports the cards (`import FluidNode from "./FluidNode"`) — drop the
  `.jsx`. Same in `renderAnimNode.jsx` (still `.jsx` at this step — it imports the
  cards via the registry, so only the registry's specifiers change).
- Cast untyped `.js`/`.jsx` imports (`Ctl`, `fluidParams`) at the boundary.

**Reuse.** `NodeProps`, `types.ts` (`NodeOf<"fluid">` for the fluid-specific cards),
the `graphModel.ts` boundary-cast pattern.

**Acceptance.** All 8 cards `.tsx`; `tsc` strict clean; `registry.test.jsx` +
`animationNodes.test.js` still green; build green.

**Verification (two-audience).**
- *Agent:* `npm run typecheck && npm run lint && npm run test && npm run build` green.
- *User:* `make dev` → animation tab renders every card (signal/fluid/output/combine/
  points) + minimize works.

**Risks.** `NodeFrame`/`Port` have their own prop shapes (not `NodeProps`) — type
them locally. SVG/ref callbacks may need explicit element types. Keep the
already-justified `exhaustive-deps`/`any` disables.

---

## Step 2 — Tighten `NodeSpec.Component` to `ComponentType<NodeProps>`

**Goal.** The payoff: a card whose props don't match `NodeProps` is now a compile
error.

**Files.** `nodes/registry.ts`.

**Design.** Change `Component: ComponentType<any>` → `ComponentType<NodeProps>` and
delete the `eslint-disable`/`Phase 8` note. The step-1 cards already satisfy it.

**Reuse.** `NodeProps` (now the cards' actual type).

**Acceptance.** `tsc` clean with the tightened type; registry tests green.

**Verification (two-audience).** *Agent:* `npm run typecheck` green (and would fail if
a card's props drifted). *User:* none (type-only).

**Risks.** If a card's inferred props are stricter than `NodeProps` (e.g. a required
field `NodeProps` marks optional), reconcile by widening `NodeProps` or relaxing the
card — `NodeProps` is the contract, so prefer adjusting the card.

---

## Step 3 — Canvas shells → `.tsx`

**Goal.** Convert the editor shell + canvas plumbing.

**Files.** `GraphCanvas`, `AnimationCanvas`, `Palette`, `renderAnimNode` (`.jsx` →
`.tsx`); `usePanZoom.js`, `ports.js` (`.js` → `.ts`); `OutputSettings.jsx` → `.tsx`.
Importers drop the extension.

**Design.** Type `GraphCanvas`'s public props (the contract documented in its header:
`graph`, `onGraphChange`, `onConnect`, `renderNode`, …) and the `helpers` it hands to
`renderNode`. `renderAnimNode(node, helpers, ctx)` returns `ReactElement | null`.
`ports.ts` types `portKey`/`canConnect`/`edgePath`. `usePanZoom` returns a typed view
+ handlers.

**Reuse.** `useGraphEditor.ts` (already typed) as the precedent for the canvas ctx;
`Graph`/`GraphNode`/`GraphEdge` types.

**Acceptance.** Shells `.tsx`; the jsdom tests (`graphCanvas.dom`, `animationCanvas.
dom`) green; build green.

**Verification (two-audience).** *Agent:* full frontend gate green. *User:* `make dev`
→ pan/zoom, drag a node, wire/delete an edge, fullscreen, minimize-all all work.

**Risks.** `getBoundingClientRect`/`ResizeObserver`/pointer types — use DOM lib
types. Keep the `GraphCanvas` keydown-delete behaviour (covered by `graphCanvas.dom`).

---

## Step 4 — Studio/fluid shells → `.tsx` (with spec 02)

**Goal.** Convert `Studio`, `FluidLab`, and the studio leaf components — and, while
rewriting `Studio`/`FluidLab`, perform **spec 02**'s extractions (`useStudioPlayback`,
`PathEditor`) so the new pieces are typed from birth.

**Files.** `studio/*.jsx` + `fluid/FluidLab.jsx` → `.tsx`; new `useStudioPlayback.ts`
+ `PathEditor.tsx` (spec 02).

**Design.** Convert the leaf studio components first (`VolumeControl`, `Spectrogram`,
`CurveView`, `SegmentRail`, `SignalCard`, `PulsePad`), then `Studio`/`FluidLab` — and
at that point apply spec 02 rather than typing the monolith. See `02-component-hooks.md`.

**Reuse.** `useDragPad.ts`, `useGraphEditor.ts` precedent. Spec 02.

**Acceptance.** Studio/fluid `.tsx`; playback + FluidLab path editor work; gate green.

**Verification (two-audience).** *Agent:* gate green + spec 02's tests. *User:* play a
segment (transport syncs), open FluidLab, edit the path.

**Risks.** `<audio>`/`<video>` refs + media event types; the double-buffered video
swap in FluidLab. Big files — lean on spec 02 to split as you convert.

---

## Step 5 (optional) — App-shell sweep

**Goal.** Finish the long tail so `allowJs` could eventually be turned off.

**Files.** `App`, `main`, `Docs`, `ErrorToast`, `LogsPanel`, `Processing`,
`ProjectList`, `review/ReviewStep`, `upload/*`, `ui/Ctl`, `ui/Info`, the `lib/*.js`
that remain (`api.js`, `segments.js`, `mel.js`, `logbus.js`, `logCapture.js`,
`useLogPoll.js`, `fluidParams.js`† ).

**Design.** Same pattern. †`fluidParams.js` is generated — convert the **generator**
(`backend/gen_fluid_params.py`) to emit `.ts` (typed `FluidParam[]`) + update the
no-diff test, rather than hand-editing the output.

**Acceptance / Verification.** Whole-app `tsc` strict clean; consider flipping
`tsconfig` `allowJs: false` once nothing `.js`/`.jsx` remains. Gate green.

**Risks.** The generated-file conversion touches `gen_fluid_params` + its parity test
together (keep them in lockstep).

---

## v1 boundary & extension points

**This spec:** the animation editor + studio/fluid are `.tsx`, `NodeSpec.Component`
is typed. **Deferred (designed-for):** the optional app-shell sweep (step 5) and
turning off `allowJs` once `.js`/`.jsx` is gone. Keeping conversions leaf-outward +
extensionless means each remaining file is an independent, low-risk follow-up.
