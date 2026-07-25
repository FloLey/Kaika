# Step 21 — The editor's per-render graph walks

**Status: DONE** — `55ff922`. **The premise was wrong and the fix is a different one.**

Measured on a realistic editor graph (8–12 independent pipelines, 40–60 cards), per full
editor render: `upstreamKey` **0.11–0.14 ms**, whole-graph stringify **0.06–0.14 ms**. The
per-render graph walks are a tenth of a millisecond, and `upstreamKey` is *slower* than the
stringify it was proposed to replace until the graph passes ~60 cards — `hash.ts`'s comment
claiming otherwise is only true for large graphs. **Fix 1's five unmemoised calls were left
alone**; memoising 0.1 ms is churn.

The real defect is not CPU. `depKey` feeds `useResolvedPoints`, which POSTs
`/resolve-points`, and its own comment says the key "should serialize the CONTRIBUTING
graph". It serialised the whole one — so any unrelated card edit refired an HTTP request per
points card. Fixed at the four sites. Fix 5 (App.tsx autosave) landed too.

Fixes 3 (`getBoundingClientRect` per edge) and 4 (`feedsMontage`) are **not done** and are
now suspect on the same grounds — measure before writing either.

**Tier.** Core.

**Goal.** Stop re-walking and re-serializing the whole graph in component render bodies. Five
independent fixes, all small, all in the hot path.

**Blocked by.** Nothing.

**Gates.** Step **26** is a *measure-first* successor: this step may take enough off the
per-edit cost that the `EditorContext` refactor stops being urgent. Do not start 26 without
numbers from this one.

**Size.** S/M. Five fixes; each is a few lines.

> Line numbers are a snapshot — re-grep before relying on one.

---

## Context: why these add up

The repo has history here — wave 1 opened because, among other things, "the editor took
minutes to open a segment". The fixes below are individually small. They matter because they
all run **per card, per render**, and because `ctx` identity changes on every graph mutation
(see step 26), so "per render" currently means "on every slider nudge, for every card".

## 1. `upstreamKey()` in five render bodies, unmemoized

`upstreamKey` (`lib/graph/hash.ts:122`) → `outputHash` → a contributing-subgraph DFS +
`stableStringify` over that subgraph + FNV-1a. Called bare in the render body at:

| Site | Blast radius |
|---|---|
| `nodes/ValuePreview.tsx:29` | **every value card** — signal, lfo, noise, shaper, gate, math, scope — full and compact |
| `nodes/ScopeNode.tsx:27` | |
| `nodes/SlideshowNode.tsx:81` | |
| `nodes/ImagegenNode.tsx:60` | |
| `nodes/MontageNode.tsx:106` | |

The correct pattern is already in the codebase twice: `OutputNode.tsx:56` and
`StreamPreview.tsx:55` wrap the equivalent in `useMemo`, with a comment saying *"don't redo it
on every unrelated re-render"*. These five never got it.

Wrap each in `useMemo` keyed on `[graph, node.id, signals]`.

## 2. `JSON.stringify([ctx.graph.nodes, ctx.graph.edges])` as a dep key — four sites

`AnimatePointsNode.tsx:33`, `MergePointsNode.tsx:24`, `SettingsVisual.tsx:57`,
`CompactPreview.tsx:62`.

Each serializes the **entire graph** — every node's data, every port binding, every points
array — on every render of that card, then feeds it to `useResolvedPoints`.

`hash.ts:116-121` documents `upstreamKey` as the intended replacement, verbatim:

> *"only the contributing set is serialized, so it's cheap on big graphs (the old pattern
> stringified every node + edge on every render)"*

Four callers never migrated. Swapping them is also **more correct**, not just faster: today an
edit to an unrelated card changes the key and refires the `/resolve-points` POST.

## 3. A forced layout read per edge, per tick

`GraphCanvas.tsx:556`, inside the edge `.map`:

```js
const rect = root.getBoundingClientRect();
```

`root` is loop-invariant. `rect` is therefore identical for every edge, and
`getBoundingClientRect` forces layout. This block runs in the render body on every tick — i.e.
once per `pointermove` while dragging or panning.

Hoist it above the `.map`. One line.

> ⚠ An earlier draft of this audit claimed `centerInContainer` performs its own
> `getBoundingClientRect`, tripling the cost. **It does not** — `ports.ts:11` takes
> `containerRect` as a parameter. The fix is worth doing; the 3× was wrong. Recorded here so
> nobody re-derives the inflated version.

Step **25** extracts `<EdgeLayer>` from this same block — pair them if 25 is in scope, since
the extraction relocates exactly these lines.

## 4. `feedsMontage()` per video card, per render

`nodes/boxPreview.ts:25` calls `feedsMontage(ctx?.graph, nodeId)`, reached from
`VideoNode.tsx` in the render body. `feedsMontage` (`lib/graph/core.ts`) builds a downstream
adjacency map over all edges and BFSes it.

The comment near the call site correctly notes the *object churn* is fine (`BoxPad` depends on
fields, not the object). It overlooks that the **call itself** is a full graph walk. On the
use-case the file itself cites — "pick twenty clips" — that is 20 graph walks per render.

Memoize on `[graph, nodeId]`.

## 5. Autosave stringifies the whole project before the debounce

`App.tsx:76-79`:

```js
const payload = { step, segments: serializeSegments(segments), output, export: exportSettings };
const jsonStr = JSON.stringify(payload);
if (jsonStr === lastSaved.current) return;
const t = setTimeout(() => { ... }, 800);
```

`serializeSegments` + a full `JSON.stringify` run **synchronously in the effect body on every
`segments` change** — every graph edit — and only then is the 800 ms timer set. On a project
with several large-graph segments this is the biggest per-keystroke allocation outside the
canvas.

⚠ **This is not a pure move.** The `jsonStr === lastSaved.current` early return needs the
string, and it exists to avoid *scheduling* a redundant save. Moving both inside the timer
changes that from "don't schedule" to "schedule, then skip at fire time" — which is fine
behaviourally (the save chain already supersedes queued writes, per the comment at `:70-72`)
but it is a real semantic change and the commit should say so. The alternative, if that
feels risky: keep the dedup but make it cheap, e.g. compare a `graphVersion`-style counter
instead of a serialized payload.

---

## Verification

**Measure first, and record the numbers** — this step's whole justification is a
responsiveness claim.

1. Baseline with the React DevTools profiler: open a large-graph segment, then drag one
   slider. Record commit count and total render time for both.
2. Apply the five fixes; re-measure both. Report before/after in the commit.
3. `make test` (vitest) — the seam tests from wave-2 step 05 cover the resolve/preview paths
   these touch.
4. **A behavioural check the tests will not catch:** with fix 2 in place, edit a card
   *unrelated* to a points pipeline and confirm `/resolve-points` does **not** refire (network
   tab). That is the correctness half of the change.

## Acceptance criteria

- No `upstreamKey` or `feedsMontage` call in a render body without a `useMemo`.
- No `JSON.stringify([...graph...])` used as a dep key anywhere — `grep` returns nothing.
- The edge-map rect read happens once per tick, not once per edge.
- Profiler numbers recorded, before and after.

## Risks

- **A `useMemo` dep list that is too narrow**, freezing a preview that should update. The five
  `upstreamKey` sites all want `[graph, node.id, signals]`; check each actually has `signals`
  in scope (some reach it via `ctx?.segment?.signals`).
- **Fix 5's semantic change** — see the warning above. If in doubt, split it into its own
  commit so it reverts independently.
