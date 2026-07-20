# Step 26 — One editor context instead of a nine-prop drill

**Tier.** Optional — and **conditional**. Do not start it without numbers from step 21.

**Goal.** Collapse the nine-prop drill that is written out five times, and in the same change
fix the reason every card re-renders on every edit. They are the same object.

**Blocked by.** Step **21** (measure-first, not technical). Step **25** if it is in scope —
both touch `GraphCanvas`.

**Size.** L. The largest change in wave 3.

> Line numbers are a snapshot — re-grep before relying on one.

---

## The two findings are one finding

### The drill

`stems, job, output, exportSettings, assets, lyricLines, onSaveLyricLines, groupClock,
groupPlaying` — nine values, written out in full **five times**:

| Site | As what |
|---|---|
| `Studio.tsx:422-439` | props passed down |
| `AnimationCanvas.tsx:14-28` | props received |
| `AnimationCanvas.tsx:76-88` | re-listed as hook options |
| `useGraphEditor.ts:97-125` | destructured |
| `useGraphEditor.ts:444-465` | assembled into `ctx` |

`specs/cleanup/13-frontend-splits.md` flagged this as "if there is appetite". No appetite was
found, and on its own that was a defensible call — prop drilling is ugly, not broken.

### The memo miss

What changes the calculus: `ctx` is built with `graph` in its dep list
(`useGraphEditor.ts:443`). `AnimationCanvas.tsx:115-118` wraps it as
`renderNode = useCallback(..., [ctx])`. `GraphCanvas.tsx:42` memoizes `NodeCard`, and
`renderNode` is one of its props.

So: **any graph mutation → new `graph` → new `ctx` → new `renderNode` → `NodeCard`'s
`React.memo` misses for all N cards.**

The comments at `GraphCanvas.tsx:39-41` and `useGraphEditor.ts:440-442` both say cards "skip
re-renders". That is true for pan, drag and edge ticks, which never touch `ctx`. It is false
for every slider nudge, connect, rename, and minimize toggle. **Two comments assert a property
the code does not have** — which is the most expensive kind of stale comment, because it stops
people from looking.

This is the multiplier that turns step 21's findings from "a few µs" into a heavy editor: one
slider drag currently means N cards × a full graph walk each.

## Why step 21 comes first

Step 21's fixes are cheap, local, and reversible. This one is a wide refactor of the editor's
data flow. If memoizing the five `upstreamKey` calls and the four `JSON.stringify` dep keys
takes the per-edit cost to something acceptable, **this step may not be worth its risk** —
the drill goes back to being merely ugly.

So: land 21, measure, and record the number here. Then decide. If this step is skipped, say so
in this file and why; a documented "we chose not to" is worth more than an open item.

## The change, if it goes ahead

Split `ctx` by volatility rather than by topic:

- **Stable half** — `stems`, `job`, `assets`, `groupClock`, `onGraphChange`, `onDetach`,
  `exportSettings`, `output`, `lyricLines`, `onSaveLyricLines`. Built once, provided via
  context. Fixes the drill.
- **Reactive half** — `graph`, `minimized`, `selection`. These genuinely change per edit and
  should be consumed by the components that need them, not passed through `renderNode`.

The memo fix follows from the split: `renderNode` stops depending on anything that changes per
edit, so `NodeCard`'s memo starts working as its comment already claims.

⚠ **A context whose value object is rebuilt each render fixes the drill and nothing else** —
every consumer re-renders anyway, and the change is pure churn. Memoize the provider value,
and verify with the profiler rather than by reading the code.

## Bundle: the same shape one level up

**`Studio.tsx` (495 lines).** Six near-identical `setSegments(prev => prev.map(s => s.id ===
activeSegId ? {...} : s))` closures at `:138-194` → one `useSegmentEdits` hook. Fullscreen
handling at `:85-95` → `useFullscreen`.

⚠ **`Studio.tsx:223-246` `dropAssetCard` mutates a graph inside a component.** `CLAUDE.md`
names the binding↔edge invariant and says wiring goes through
`frontend/src/lib/graph/mutations.ts` helpers only. This is a violation sitting in a component
file — move it beside `addAssetCard` in `mutations.ts`. **Treat this as the highest-value item
in the bundle**: it is a stated invariant being broken, independent of any refactor.

Also `Studio.tsx:97-100` (`activeSeg`) and `:201-204` (`segIdx`) are memoized independently,
and `segIdx` is sufficient to derive `activeSeg`. They can disagree transiently during a
segment delete.

**`App.tsx` (396 lines).** Twelve `useState`s all describing one project, all set together in
`openProject` (`:192-235`) → a `useProject()` hook. The save payload literal is written three
times (`:76`, `:106`, `:124`) → one `buildSavePayload()`. That last one is worth doing even if
nothing else in this step happens — three copies of a persisted payload shape is a drift
waiting to become a data bug.

---

## Verification

1. **The numbers are the acceptance test.** Profiler: open a large-graph segment, drag one
   slider. Card render count should drop from N to ~1. Record before/after.
2. `make test` — wave-2 steps 05a/05b put seam tests under exactly this machinery
   (`studioShell.dom.test.tsx`, `studioLeaves.dom.test.tsx`, the position tests).
3. `npx tsc --noEmit` — a context refactor's main safety net.
4. By hand: every `ctx` consumer still works. Card previews update on upstream edits; lyric
   editing saves; the group clock still drives synced playback; asset drops still land wired.
5. `dropAssetCard` still produces a correctly wired card **after** moving to `mutations.ts` —
   this is the binding↔edge invariant, so verify by wiring, not just by rendering.

## Acceptance criteria

- Card render count per edit is measurably reduced (or the step is documented as skipped).
- The nine values are written once, not five times.
- The two stale comments claiming cards skip re-renders are now **true**, or corrected.
- `dropAssetCard` lives in `lib/graph/mutations.ts`.
- No `GRAPH_VERSION` change — this step must not touch the persisted graph shape. If it
  somehow does, stop: that needs a `normalizeGraph` migration and is out of scope.

## Risks

- **A refactor that costs a week and changes no measurement.** The step-21 gate exists to
  prevent exactly this.
- **Context + memoized provider value done half-way** — see the warning above.
- **Breaking synced playback.** `groupClock`/`groupPlaying` are the props most entangled with
  timing behaviour, and the ones least likely to be covered by a test. Exercise transport by
  hand.
