# Step 25 — GraphCanvas: an edge layer, and free panning

**Status: DONE** — item 1 `dc5b9db` (wave 4), item 2 CLOSED on measurement, item 3 `737b29a`.

> Item 1 (`<EdgeLayer>`) landed as a JSX-only extraction: 759 → 731 lines. The rect read and
> the geometry `.map` deliberately STAYED in the parent — moving them would have re-opened
> `2f7bb48`'s hoist invisibly, since the rendered output looks identical either way.

**item 3 DONE** (`737b29a`) — the zoom limit measures once per gesture instead of
once per wheel tick. **Counted: 400 forced layout reads → 40** for 20 cards over 10 ticks.

⚠ **Counted, not timed.** jsdom reports `offsetWidth` as 0 and cannot price a layout
flush, so the read *count* is verifiable here and the millisecond cost is not. The count is
the structural claim and it scales with card count × event rate; a real browser profile
would put a number on it, and nobody has one yet. Same caveat applies to item 2 below.

**Item 2 (panning commits React state per pointermove): CLOSED — measured in a real
browser, not worth doing.**

Profiled against the running app (Chrome, Playground segment, `getBoundingClientRect`
instrumented, two independent background drags):

| | |
|---|---|
| layout reads per pointermove | **5** |
| cost per read | **0.01–0.025 ms** |
| **total per pointermove** | **0.05–0.12 ms** |

At ~60 pointermoves/second that is **3–7 ms per second of panning** — under 1% of the main
thread. Moving pan off React state would save some fraction of that, for a gesture rewrite
with real regression risk. The audit's reasoning was sound and the conclusion is still no.

**What this also confirms is that the hoist in `2f7bb48` was the part that mattered.**
Before it, reads per pointermove scaled with EDGE COUNT (11 edges → 22/move); a 40-edge
graph would have been ~80 reads/move ≈ 2 ms/move ≈ 120 ms per second of panning, which is
a real budget. After it the count is flat at 5 regardless of graph size, and card
re-renders during a pan are 0 (`NodeCard`'s memo holds). The scaling term is gone; what
remains is a constant too small to chase.

⚠ Measured on a 3-card / 2-edge segment. That is fine for the *per-read cost* and for the
*post-hoist flatness* (which is the claim), but the absolute totals on a 40-card graph were
not measured directly — the argument is that neither term scales any more, not that a big
graph was tested.

Item 1 (`<EdgeLayer>`) is readability and stands on its own.

**Original status note (superseded):**

Step 21 measured the editor's per-render graph walks at **0.1 ms**, against an audit that
described them as a heavy per-edit cost. This step's items 2 and 3 (pan committing React
state per pointermove, `getMinScale` measuring every node per wheel event) are the same
*kind* of claim from the same audit, and **neither has been measured**. Profile before
writing either — on this wave's record, the prior is against them.

Item 1 (extracting `<EdgeLayer>`) is a readability change and stands on its own merits.

**Tier.** Optional. But it is **unfinished wave-2 work**, not a new idea.

**Goal.** Finish the `GraphCanvas.tsx` split that step 13 planned, and make background panning
as cheap as node dragging already is.

**Blocked by.** Step **21** — it touches the same edge-map block, and doing 21's rect hoist
inside the extracted `<EdgeLayer>` is cheaper than doing it twice.

**Size.** M.

> Line numbers are a snapshot — re-grep before relying on one.

---

## Why this is leftover, not new

`specs/cleanup/13-frontend-splits.md` planned four extractions from `GraphCanvas.tsx`:
`useNodeDrag`, `useWireConnect`, `useMarquee`, and `<EdgeLayer>`. **Only `useWindowPointer`
shipped** (commit `98fc397`, "one window-pointer gesture helper instead of three"). That was
the shared primitive underneath the three gesture hooks — the right thing to do first, and
then the hooks themselves never followed.

The file is 717 lines. The three gesture blocks are still inline (`:250-342`, `:344-442`,
`:444-489`) and the edge layer is still in the render body (`:550-567`, `:601-636`).

**The argument for finishing it now is not line count.** It is that the perf fixes in this
step and step 21 both live in exactly those blocks, and doing surgery on inline code inside a
717-line component is how a subtle gesture regression gets introduced.

## 1. Extract `<EdgeLayer>`

The geometry block at `:550-567` and the render at `:601-636`. This is the natural home for
step 21's fix 3 (hoist `root.getBoundingClientRect()` out of the per-edge `.map`) — do them in
one commit if 21 has not already landed, or fold 21's change into the extraction if it has.

The extracted component takes the edges, the port element map, and the container rect;
it returns the SVG. Keeping it memoized on `[graph.edges, tick]` is the point — today it
recomputes as part of every `GraphCanvas` render, including renders caused by things that
cannot move an edge.

## 2. Panning still commits React state per pointermove

`usePanZoom.ts:127` calls `setView(...)` on every move.

Node dragging was deliberately optimised away from this: `GraphCanvas.tsx:250-255` mutates a
ref and bumps a `tick`, with the comment "no graph commit while dragging". Panning never got
the same treatment, and it is worse than it looks:

`setView` re-renders `GraphCanvas` → the `useLayoutEffect` tick at `:238-240` has `view` in its
deps → it fires → **a second render** → both recompute the whole edge array, each with its
per-edge layout read (step 21's fix 3). So one pointermove during a pan costs two full edge
recomputations.

Give panning the drag treatment: mutate a ref, write the CSS transform imperatively, commit
`view` once on pointer-up. `useWindowPointer` (already extracted) is the primitive for it.

⚠ **Anything reading `view` during a pan must still work.** Check what depends on it — the
minimap, if there is one; the fit-view calculation; any coordinate conversion used by an
in-flight wire drag. A pan that no longer updates `view` until pointer-up will silently break
whichever of those reads it mid-gesture.

## 3. The zoom floor measures every node on every wheel event

`GraphCanvas.tsx:128-140` `getMinScale` → `measureBBox` (`:108-123`) reads `offsetWidth` and
`offsetHeight` **for every node**, and it is called from `usePanZoom`'s `clamp` on every wheel
event.

On a 40-card graph with a trackpad (~60 events/second) that is ~2400 forced layout reads per
second while zooming.

Cache the bbox per graph identity, invalidate on drag-commit and on the layout tick. The
existing `displayNode` WeakMap in `useGraphEditor.ts:50-65` is a good model for identity-keyed
caching in this codebase.

⚠ The bbox depends on rendered *size*, not just graph structure — a card that grows when
expanded changes it without changing `graph`. Invalidate on the minimize/expand toggle too, or
key the cache on something that captures it. Getting this wrong makes the zoom floor stale,
which shows up as "I can't zoom out far enough" — annoying and hard to trace.

---

## Verification

**Gesture work has poor test coverage and high regression risk. Verify by hand as well as by
suite.**

1. `make test` — `graphCanvas.dom.test.tsx`, `boxPad*.dom.test.tsx`, `useDragPad.test.tsx` and
   the wave-2 position tests (`step 05b`) cover parts of this.
2. By hand, on a large-graph segment: drag a node; pan the background; zoom in and out to both
   limits; drag a wire; marquee-select; then **do each of those while a stream preview is
   rendering**, which is when the canvas is under the most render pressure.
3. Profiler: pan for 3 seconds, before and after. Record commit counts.
4. Confirm `view` is correct after a pan — pan, then fit-view, then pan again.

## Acceptance criteria

- `<EdgeLayer>` is its own component and is memoized.
- Panning does not commit React state per pointermove.
- `measureBBox` does not run per wheel event.
- `GraphCanvas.tsx` is meaningfully smaller, and the three gesture blocks are extracted **or**
  a note is added to `13-frontend-splits.md` explaining why they stayed.
- No gesture regression, verified by hand against the list above.

## Risks

- **The mid-gesture `view` reader** (see the warning in item 2) — the most likely real
  breakage.
- **Stale bbox cache** in item 3 — presents as a wrong zoom limit, not a crash, so it survives
  casual testing. Test expand/collapse explicitly.
- **Scope creep into step 26.** This step does not touch `ctx` or prop drilling. If a change
  starts pulling on `useGraphEditor`'s context shape, stop — that is 26.
