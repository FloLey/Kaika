# 11 — Points source card (a source at each drawn point)

> A fluid emits from **one** source today (a single point, ~the centre). This adds
> a **points** card you draw points on; wired into a fluid, the fluid emits **one
> source per point** — all sharing the fluid's settings. First simple version:
> static points. Built step by step; each step lands runnable + verifiable. No code
> until its step.

## Locked decisions

1. **Separate Points card → fluid `positions` input.** A new `points` node (draw
   surface) outputs a set of points; wire it into a new **`positions`** side-input on
   the fluid. Wired → one source per point; nothing wired → today's single-centre
   source (back-compat).
2. **All points share the fluid's settings (v1).** Every point emits with the SAME
   colour / force / emit / radius / angle / radial as the fluid card, just at its own
   position. Signals still modulate the fluid's params and apply to every point.
   Per-point settings are deferred.
3. **v1 = static points** (the same set every frame). The executor's `positions`
   resolution stays generic so the future **per-frame / animated** points (appear /
   disappear / move) slot in without reshaping it.

## Architecture this builds on

- `fluid.simulate(params)` already accepts `params["sources"]` — a **list** of
  emitter dicts injected together into one field (added for combine,
  `backend/fluid.py`). So "a source per point" = N emitters in one sim — no sim change.
- `backend/graph.py:_Dag.emitters(fluid)` returns `[build_params(fluid)["source"]]`
  (one emitter — the `source` dict carries `points` + the modulated params);
  `_Dag.video(fluid)` runs `simulate(build_params(fluid))`. These are the only two
  spots that change.
- The executor resolves inputs by `_video_source(graph, target, port)` over edges;
  the contributing-DAG hash + `validate` already walk **all** edges, so a new
  `points` edge rides along for caching/validation.
- Reusable UI: `FluidLab.jsx` has a **path editor** — click the stage to add a
  point, drag a marker to move it, remove a point — with `.fluid-marker` + SVG
  overlay styling. That's exactly the Points card's draw surface. Ports via
  `NodeFrame` (`sideIn`/`sideOut`) + `Port` (carries a `flow` tag); `canConnect`
  (`ports.js`) gates wires by matching `flow`; edges + `connectVideo` in
  `frontend/src/lib/graphModel.js`.

## Core model additions (extends `01` / `10`)

**`points` node:**
```jsonc
{ "id": "n-…", "type": "points", "x": 0, "y": 0,
  "data": { "points": [[0.5, 0.5]] } }      // normalised 0..1, seeded with one centre point
```
One output port `out`, **flow `"points"`** (a new flow, distinct from `value` /
`video`).

**Fluid gains a `positions` input** — a side-in port, flow `"points"`. A points edge:
`{ source: pointsId, sourcePort: "out", target: fluidId, targetPort: "positions" }`.
The `positions` input is NOT a param port (no binding); it's a separate side input,
the way combine slots are video inputs.

**Executor expansion** — `_Dag` turns a fluid into emitters:
- a `points` node wired to `fluid.positions` → **one emitter per point**: the fluid's
  `source` dict copied with `points: [[px, py]]` (a single static position, path
  traversal off) for each drawn point;
- else → the single emitter (today's behaviour).

`video(fluid)` runs `simulate({…, "sources": <those emitters>})`; `emitters(fluid)`
returns the same list — so a multi-point fluid also composes into a **merge combine**
(its points become more emitters in the shared sim).

---

## Step 1 — Backend: a fluid emits one source per wired point

**Goal.** Make a fluid with a wired `points` node emit a source at every point
(sharing its params); unchanged when nothing is wired.

**Files.** `backend/graph.py` (`_Dag.emitters` / `video`, a `_fluid_emitters`
helper). `backend/fluid.py` (`simulate` `sources` — reused, unchanged).

**Design.**
- Add `_Dag._fluid_emitters(fluid_node) -> list`:
  - `base = build_params(…, fluid_node)["source"]` (the single emitter, with the
    modulated params + static colour/etc).
  - `pts_id = _video_source(self.graph, fluid_node["id"], "positions")`.
  - if `pts_id` and `nodes[pts_id]["type"] == "points"` and it has points:
    return `[{**base, "points": [[px, py]], "path_speed": 0} for (px, py) in points]`
    (each emitter static at its point — copy is shallow; only `points` differs).
  - else `[base]`.
- `emitters(fluid)` → `_fluid_emitters(node)` (so it composes with merge).
- `video(fluid)` → build the params dict but with `"sources": _fluid_emitters(node)`
  instead of `"source": base`; everything else (`output`, `fluid` medium, `duration`,
  `fps`) as `build_params` already produces. (Factor the params assembly so both the
  single-source and multi-source forms share it.)
- `validate`/`output_hash` need no change — the `points` edge is already walked.

**Reuse.** `build_params` (emitter/source assembly), `fluid.simulate(sources=…)`,
`_video_source`, the `_Dag` memoization.

**Acceptance.** A fluid + points(3) renders three plumes at the drawn positions; a
fluid with no `positions` edge renders byte-identically to before; a multi-point
fluid feeding a merge contributes N emitters.

**Verification (two-audience).**
- *Agent:* python/`curl` a hand-authored graph `points → fluid → output` with points
  at `[0.25,0.5]`, `[0.5,0.5]`, `[0.75,0.5]`; assert three bright regions at those x
  positions and that a no-`positions` graph equals the prior single-source render.
  `tests/test_graph_points.py` (Step 4) formalises it.
- *User:* open the rendered mp4 — three jets where the points are.

**Risks.** Per-point `path_speed: 0` keeps each point static even though `base` may
carry a path; document that a wired points set overrides the fluid's own path. N×
splats/frame is cheap (the FFT solve dominates).

---

## Step 2 — Frontend: graph model

**Goal.** Mirror the model: a `points` node, the `"points"` flow, point-edit helpers,
and `positions` wiring.

**Files.** `frontend/src/lib/graphModel.js`.

**Design.**
- `pointsNode(x, y)` factory → `{ type: "points", data: { points: [[0.5, 0.5]] } }`.
- Point helpers (pure, return a new graph): `addPoint(graph, id, [x,y])`,
  `movePoint(graph, id, i, [x,y])`, `removePoint(graph, id, i)`.
- Wire a points edge with the existing `connectVideo(graph, srcId, "out", fluidId,
  "positions")` (generic edge; last-wins).
- `normalizeGraph` leaves a `points` node as-is (or seeds an empty `points` array).
- `outputRenderable` / `outputHash` already include any node upstream via the edge
  walk — **verify** a points node shows up in a fluid's contributing set and that
  moving a point changes the output's hash.

**Reuse.** `mkNodeId`, `connectVideo`, `outputContributing`, hashing helpers.

**Acceptance.** Factory + helpers produce conformant data; a `points → fluid →
output` graph validates; the output's hash changes when a point moves and is stable
when an unrelated node moves.

**Verification (two-audience).**
- *Agent:* vitest — factory shape; add/move/remove point; `outputHash` sensitivity to
  a point move; `validate` ok for points→fluid→output.
- *User:* none (pure lib) — green vitest + `npm run build`.

**Risks.** `points` is a small array — fine to hash whole. Keep point coords numbers
(not strings) so the hash is stable.

---

## Step 3 — Frontend: Points card UI + fluid `positions` port + palette

**Goal.** A draw-on-it Points card, a `positions` input on the fluid, and a palette
entry.

**Files.** `components/animation/nodes/PointsNode.jsx` (new), `FluidNode.jsx`
(add the `positions` side-in port + a "sources: N points" note when wired),
`Palette.jsx` (`+ Points`), `styles/animation.css`, reference
`components/fluid/FluidLab.jsx` for the editor interaction.

**Design.**
- `PointsNode`: a square draw surface (use the project output aspect for parity);
  click empty space to add a point, drag a marker to move it, double-click / a marker
  ✕ to remove (mirror the FluidLab path-editor pointer logic + `.fluid-marker`
  markers, rendered over an SVG/overlay). All edits go through the Step-2 helpers via
  `onGraphChange`. One `out` port, flow `"points"`, on the right edge.
- `FluidNode`: add a `sideIn` (or a dedicated row) **`positions`** port, flow
  `"points"`; when a points node is wired, replace the "source: centre point" note
  with "sources: N points (from points card)"; the existing radial/centre note shows
  only when unwired.
- `Palette`: `+ Points` drops a points node at canvas centre.
- `canConnect` already permits points→points (matching flow); the generic
  `onConnect` fallback creates the edge — no canvas change needed.
- CSS: `.gc-port-points` colour (a third hue, e.g. courant/teal) to distinguish the
  flow; `.anim-points-pad` draw surface + markers (reuse `.fluid-marker` styling).

**Reuse.** `FluidLab.jsx` path editor (interaction + markers), `NodeFrame`/`Port`,
`canConnect`, the Step-2 helpers.

**Acceptance.** Add a Points card, draw a few points, wire it into a fluid's
`positions`; the fluid notes the point count; build/lint green.

**Verification (two-audience).**
- *Agent:* `npm run build` + `npm run lint`; a vitest render of `PointsNode` asserting
  a marker per point + the `out` port; `FluidNode` shows the `positions` port.
- *User:* in `make dev` → animation tab: `+ Points`, click to scatter points, wire
  into a fluid → output; render shows a source at each point. Move a point → it
  re-renders.

**Risks.** Marker drag must convert pad-local coords → 0..1 and use `.no-drag` so it
doesn't drag the card (as FluidLab does). Pad aspect vs sim aspect — keep the pad the
output aspect so positions land where drawn.

---

## Step 4 — Tests + docs

**Goal.** Lock it in and document it.

**Files.** `tests/test_graph_points.py` (new), `frontend/src/__tests__/graphModel.test.js`
(points cases), `frontend/src/components/Docs.jsx` (animation section), `README.md`.

**Design / acceptance.** Backend: one-source-per-point (N bright regions), no-`positions`
back-compat equals the prior single-source render, a multi-point fluid into a merge
contributes N emitters, `output_hash` changes on a point move. Frontend: points model
round-trip + helpers + hash. Docs: a "Placing sources — the points card" subsection
(draw points, wire into a fluid, each becomes a source; v1 static, params shared) +
README mention.

**Verification (two-audience).**
- *Agent:* `pytest -q`, `npm run test`, `npm run lint`, `npm run build`, `ruff check`
  all green.
- *User:* the `?` guide shows the points subsection; the e2e from Step 3 matches it.

**Risks.** Audio-free: const fluids need no signal mocking (as the combine tests do).

---

## v1 boundary & extension points

**In v1:** a `points` card with a static drawn set; wired into a fluid's `positions`,
one source per point sharing the fluid's params; composes with merge. **Deferred
(designed-for):** per-frame / animated points (appear / disappear / move over time —
the `positions` input could resolve to a per-frame list), per-point settings, and
signal-driven point sets. Keeping `_fluid_emitters` and the `points` flow generic
keeps these cheap to add.
