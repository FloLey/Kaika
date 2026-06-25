# 05 — Hand-built canvas (pan / zoom / ports / edges)

> The reusable, node-type-agnostic playground: an infinite-feeling stage you can
> pan and zoom, nodes you can drag, ports you wire together with bezier edges, and
> selection + delete. Knows nothing about signals or fluid — it renders whatever
> nodes `06` provides and reports graph mutations up.

## Goal

A `GraphCanvas` component that: positions node cards in graph space, applies a
pan/zoom transform, draws edges as SVG beziers between port anchors, and handles
the interactions (drag node, drag-to-connect, click-to-select, delete). All
without a third-party library (decision locked).

## Files

- **Create** `frontend/src/components/animation/GraphCanvas.jsx`
- **Create** `frontend/src/components/animation/usePanZoom.js` (small hook)
- **Create** `frontend/src/components/animation/ports.js` (port-geometry helpers)
- *(Styling in `08`; node cards in `06`.)*

## Design detail

### Coordinate model

- **Graph space**: node `x/y` (px). **Screen space**: graph space transformed by
  `{ tx, ty, scale }`. One transform on a `.gc-stage` wrapper:
  `transform: translate(tx, ty) scale(scale)`.
- `usePanZoom` owns `{tx,ty,scale}` (seeded from `graph.view`), exposes
  `onWheel` (zoom toward cursor, clamp scale ~0.4–2.0), and background-drag to pan.
  Persist back to `graph.view` on change (debounced) so `07` autosaves it.

### Component shape

```jsx
<GraphCanvas
  graph={graph}
  onGraphChange={(updater) => ...}     // (graph) => graph; for moves/connects/deletes
  selected={selId} onSelect={setSelId}
  renderNode={(node, helpers) => <SomeNode .../>}  // 06 supplies this
/>
```

`renderNode` receives `helpers`:
- `onMove(id, x, y)` — commit a node position (during/after drag).
- `portRef(nodeId, portId, kind)` — ref callback so the canvas can measure a port's
  center for edge anchoring (`kind: "in" | "out"`).
- `startConnect(nodeId, portId)` / connection state — to begin a wire from a port.
- `selected` flag.

### Node dragging

- Pointer down on a node's drag handle → capture pointer; on move, convert screen
  delta to graph delta (`/scale`) and update a local "drag offset"; on up, call
  `onMove`. Use `setPointerCapture` for robustness. Don't start a drag from inside a
  control (sliders, selects) — check `e.target.closest('.no-drag')`.

### Ports & connecting

- Each node exposes ports (in/out) as small circles with a stable
  `data-node`/`data-port`. Value-source nodes (signal/constant) have one **out**
  port; the fluid node has one **in** port per modulatable param + one **out**
  (video); output node has one **in** (video).
- **Connect interaction:** pointer-down on an `out` port → enter "connecting" mode,
  draw a live bezier from the port to the cursor; pointer-up over an `in` port →
  emit a connect request `onConnect(sourceId, sourcePort, targetId, targetPort)`
  (`07`/`06` translate that into `graphModel.connect`). Pointer-up elsewhere
  cancels. Validate compatibility (out→in, no self, video↔video vs value↔param)
  before accepting; reject visually otherwise.
- A param `in` port already wired shows its edge; dropping a new wire replaces it
  (`connect` already does last-wins).

### Edge rendering

- An SVG layer **inside** the transformed stage (so edges scale with nodes), or an
  overlay in screen space recomputed from measured port centers. Recommended:
  overlay SVG in **screen space**, with port centers read from `getBoundingClientRect`
  relative to the canvas root, recomputed on graph change / pan / zoom / resize via
  a `ResizeObserver` + a render tick. Bezier:
  `M x1 y1 C x1+dx y1, x2-dx y2, x2 y2` with `dx = clamp(|x2-x1|*0.5, 30, 120)`.
- Edge hit area: a fat transparent stroke under the visible stroke for easy
  click-select; selected edge highlights; `Delete`/`Backspace` removes it.

### Selection & delete

- Click a node/edge → `onSelect(id)`; click background → clear. `Delete` key on a
  selected node → `graphModel.removeNode`; on a selected edge → `disconnect` the
  corresponding param. Guard so deleting the fluid/output is allowed but
  re-addable from the palette.

### Performance

- v1 graphs are tiny (<20 nodes). Plain React state is fine. Memoize node cards by
  id+data; recompute edge geometry only on the triggers above, not every frame.
  The live "connecting" wire follows the cursor via a single ephemeral path (local
  state), not a graph mutation.

## Reuse

- Pointer-capture drag pattern exists in `FluidLab.jsx` (path marker drag,
  `fluid.css` markers) and `Spectrogram.jsx` (band-handle drag) — mirror their
  approach for consistency.
- Theme tokens for the stage backdrop come in `08`.

## Acceptance criteria

- [ ] Canvas renders nodes at their `x/y`; background drag pans; wheel zooms toward
      the cursor within clamped bounds.
- [ ] A node drags smoothly and commits its new position; controls inside a node
      don't trigger a drag.
- [ ] Dragging from an `out` port to a compatible `in` port creates an edge;
      incompatible drops are rejected; dropping on empty cancels.
- [ ] Edges track nodes across move/pan/zoom/resize; selecting an edge and pressing
      Delete removes it.
- [ ] No console errors; `npm run build`/`lint` green.

## Verification (two-audience)

**Fixture/seed data:** a throwaway harness — render `GraphCanvas` with a couple of
placeholder nodes (plain divs) and `emptyGraph()` from `04`, mounted on a scratch
route or Storybook-less temporary mount inside the animation tab stub.

**Agent check:** `cd frontend && npm run build && npm run lint`. Optionally a
vitest + @testing-library test that simulates a pointer drag between two port
elements and asserts `onConnect` fires with the right ids (geometry-light).

**User check (M2 begins):** in `make dev`, open the animation tab (stubbed in `07`,
or a temporary mount), and: pan by dragging the background, zoom with the wheel,
drag a placeholder node, draw a wire from one node's out port to another's in port,
select the wire and press Delete. Everything should feel direct and lag-free.

## Risks & open questions

- **Screen-space vs stage-space edges** — screen-space overlay avoids SVG scaling
  blur and stroke-width scaling, at the cost of recomputing geometry on transform
  changes. Chosen for crispness; keep the recompute cheap.
- **Touch/trackpad** — support wheel-zoom + drag-pan; pinch-zoom is a nice-to-have,
  not required for v1 (local single-user desktop tool).
- **Edge anchoring during fast zoom** — recompute on a rAF tick to avoid stale
  rects; acceptable for tiny graphs.
