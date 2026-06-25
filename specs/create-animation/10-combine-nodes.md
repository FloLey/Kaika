# 10 — Combine card: merge + layered fluids

> Compose multiple fluids into one animation, two ways: **merge** (their sources
> share one simulation and interact) and **layered** (each is rendered separately
> and stacked with per-input transparency). Inputs are **video streams** — the
> output of a `fluid`, another `combine`, or an `output` (which gains a pass-through
> video out). Built **step by step**; each step below lands in a runnable, verifiable
> state. No combine code is written until its step.

## Locked decisions

1. **Merge owns its medium.** The combine card carries the shared physics
   (`dissipation / velocity_dissipation / viscosity / vorticity`). A fluid feeding a
   merge contributes only its **emitter** (color, emit, radius, force, angle,
   position/path, radial, r/g/b, intensity, opacity — with their signal modulation);
   its own medium is ignored when merged.
2. **Layered = alpha-over + per-input opacity.** Inputs render **background-free**
   (dye on transparent). Layers composite top→bottom in **input order**; a bright
   upper layer hides what's beneath; each input has an **opacity** slider. The
   project **background is painted once, at the terminal output**. No blend-mode
   selector.
3. **Dynamic N inputs** — starts with two, `+` to add a slot, ✕ to remove one.
4. **Combine settings are static in v1** — signals still drive the upstream fluids;
   modulating the combine's own medium/opacity is a deferred extension (the executor
   stays generic so it slots in later).

## Architecture this builds on (current code)

- **Per-output rendering.** Each `OutputNode` auto-renders the pipeline feeding it
  via `api.renderGraph({…, output_id})`; `backend/graph.py:render(…, output_id)`
  resolves the fluid for that output and caches per-output (`_fluid_for_output`,
  `output_hash`, `build_params`).
- **One video edge type today:** `fluid.out → output.video`. `graph.py:resolve_source`
  already reserves a `combine` branch.
- `fluid.simulate(params)` injects **one** `source` per frame; `render_mp4(frames,
  fps, path, w, h)` encodes. Output settings (size/quality/fps/background) in
  `frontend/src/lib/output.js`.
- Frontend model: `frontend/src/lib/graphModel.js` (factories, `validate`,
  `outputRenderable`, `outputHash`, `contributingIds`); cards under
  `components/animation/nodes/`; `Palette.jsx`; `GraphCanvas.jsx` (video flow keyed
  by port `flow: "value" | "video"`, `canConnect`).

## Core model additions (extends `01-data-model.md`)

**Video stream is first-class.** A *video-producing* node is `fluid`, `combine`, or
`output` (pass-through). Video edges connect `out`→`in` between them; the executor
resolves the **video DAG** feeding each terminal output.

**`combine` node:**
```jsonc
{
  "id": "n-…", "type": "combine", "x": 0, "y": 0,
  "data": {
    "mode": "merge" | "stack",
    "inputs": [ { "id": "in-ab12", "opacity": 1.0 }, { "id": "in-cd34", "opacity": 1.0 } ],
    "medium": { "dissipation": 0.95, "velocity_dissipation": 0.97, "viscosity": 0.0, "vorticity": 6.0 }
  }
}
```
- `inputs` — an **ordered** list of input slots (order = layer order, index 0 = top).
  A video edge targets a slot via `targetPort: "<slot.id>"`. `opacity` is used in
  `stack`; `medium` is used in `merge`. Adding an input pushes a slot; removing one
  drops the slot **and its incident edge**.
- **`output` node** gains a `video` **out** port (forwards its input video).

**Edges (video):** `{ id, source, sourcePort: "out"|"video", target, targetPort: "<slotId>"|"video" }`.

**Two resolution passes in the executor** (memoized, type-dispatched):
- `resolve_video(node) -> frames` (dye-on-transparent, length `nframes`):
  - `fluid` → `build_params` → `simulate` → frames.
  - `output` → `resolve_video(its single input)` (pass-through).
  - `combine.stack` → `resolve_video` each input → **alpha-over composite** in slot
    order, each scaled by its `opacity`.
  - `combine.merge` → `resolve_emitters(...)` → **one multi-source `simulate`** using
    the combine's `medium`.
- `resolve_emitters(node) -> [emitter, …]` (merge only): `fluid` → its emitter dict;
  `output` → pass-through; `combine.merge` → concat of its inputs' emitters;
  `combine.stack` → **error** (a composited video has no single emitter set).

**Backgrounds:** intermediate renders are background-free; the **terminal output**
paints the project background once — moved out of the per-sim render.

---

## Step 1 — Backend: multi-emitter sim + background-free frames

**Goal.** `fluid.simulate()` runs **one** field with **N emitters**, and produces
frames with **no background baked in** (background applied later, at the terminal).

**Files.** `backend/fluid.py` (`simulate`, the source loop, `render_mp4` / a new
`apply_background`).

**Design.**
- Accept `params["sources"]` — a list of source dicts, each shaped exactly like
  today's single `params["source"]` (every field scalar-or-array via `_series`).
  Back-compat: if `sources` is absent, wrap the single `source` as `[source]`.
- Per frame: set medium once, then loop emitters — each does its own `pos_at`,
  `add_dye`, `add_force`/`add_radial` with its own per-frame values. `step()` once.
- Render **dye-on-transparent**: do **not** fill the project background inside the
  sim/encode. Add `apply_background(frames, color)` (or a `background` arg at the
  terminal encode) that composites the dye frames over a solid color. Audit where
  background is applied today and move it to the terminal (Step 2 calls it).

**Reuse.** `_series`, `FluidSim`, `add_dye/add_force/add_radial`, `pos_at`,
`render_mp4`.

**Acceptance.** Two emitters at different positions visibly interact in one clip;
scalar single-`source` path byte-equivalent to before; frames carry no baked bg;
`apply_background` paints it correctly.

**Verification (two-audience).**
- *Agent:* Python snippet — `simulate({sources:[A,B], fluid:{…}})` renders; assert
  shape, that the two plumes mix, and that a single-`source` call equals the old
  output. Confirm frames are background-free, then `apply_background` fills it.
- *User:* open `/tmp/*.mp4` from the snippet — two colored jets swirling into each
  other; the existing Fluid Lab / single-fluid renders look unchanged.

**Risks.** Cost of N emitters is N splats/frame (cheap vs the FFT solve). Decide the
exact background hand-off point (encode vs a pre-encode composite) so Step 2's
compositor and the terminal share it.

---

## Step 2 — Backend: video-DAG executor + compositor + passthrough

**Goal.** Resolve an arbitrary video DAG feeding an output: fluids, `output`
pass-throughs, `combine.stack` (composite), `combine.merge` (multi-emitter sim).

**Files.** `backend/graph.py` (`resolve_video`, `resolve_emitters`, `composite`,
generalize `validate` / `output_hash` / `render`), `backend/animation_params.py`
(medium defaults for combine).

**Design.**
- `resolve_video(node_id) -> frames` and `resolve_emitters(node_id) -> [emitter]`
  per the model above; both **memoized** per render.
- `composite(layers, opacities) -> frames`: alpha-over, treating dye-on-transparent
  as premultiplied (alpha ≈ luminance). Bottom→top, `out = premult_i + out*(1 - a_i)`
  with `a_i = clamp(luminance(layer_i)) * opacity_i`, `premult_i = layer_i *
  opacity_i`. Output background-free; the terminal applies bg.
- `render(…, output_id)`: `frames = resolve_video(input_of(output_id))`;
  `apply_background(frames, output.background)`; `render_mp4` at output size/fps.
- **Emitter extraction** (`fluid` → emitter): the source dict `build_params`
  already assembles (`_source_statics` + per-frame `src_params`) **is** the emitter;
  for merge, gather emitters and run `simulate({sources:[…], fluid: combine.medium})`.
- Generalize `validate`: ≥1 output; each output wired to exactly one **video
  producer**; whole video DAG acyclic; **merge inputs must be emitter-resolvable**
  (`resolve_emitters` raises on a `stack` upstream of a `merge`). Generalize
  `output_hash` to fold in the **entire contributing video DAG** for that output
  (all upstream node data + referenced signals), not just one fluid.

**Reuse.** `build_params` (emitter assembly), `_fluid_value_node_ids` →
generalize to a DAG walk, `output_hash` structure, `_has_cycle`, `simulate` (Step 1).

**Acceptance.** Merge of two fluids → one interacting clip; stack of two → alpha-over
with opacities + bg at the end; `output`→`combine` pass-through works; per-output
caching keyed on the contributing subgraph; `stack`→`merge` rejected (400).

**Verification (two-audience).**
- *Agent:* `curl /animate` with three hand-authored fixtures — (a) merge two fluids,
  (b) stack two with opacities 1.0 / 0.5, (c) `fluid→output→combine→output`
  pass-through; `ffprobe` each + a pixel check (overlap region differs between merge
  and stack; lower opacity = dimmer layer). A bad graph (stack feeding a merge) →
  HTTP 400. New `tests/test_graph_combine.py`.
- *User:* run the curls, `open` the mp4s — the merge clip's plumes physically swirl
  together; the stack clip shows one layer over the other with the top fading at
  0.5 opacity.

**Risks.** Cost: `stack` renders N sub-clips (N× a single render) then composites;
note it. Memoize shared sub-DAGs. Keep `resolve_*` type-dispatched so future node
types slot in.

---

## Step 3 — Frontend: graph model

**Goal.** Mirror the model + executor generalization in `graphModel.js`.

**Files.** `frontend/src/lib/graphModel.js`.

**Design.**
- `combineNode(x, y)` factory (mode `"merge"`, two input slots, default `medium`).
- `outputNode` gains a `video` out port (data unchanged; the port is in the card).
- Video-edge helpers: `connectVideo(graph, srcId, srcPort, tgtId, slotId)`,
  add/remove a combine input slot (slot add/remove keeps the edge invariant), and
  `removeNode` resets/cleans video edges + slots.
- `normalizeGraph` migrates older graphs (combine with missing fields; output
  without the out port is fine — it's UI-only).
- Generalize `validate` / `outputRenderable` / `outputHash` to walk the **video
  DAG** from each output (reuse `contributingIds` pattern): renderable = input
  resolves to a valid acyclic video DAG; merge inputs emitter-resolvable.

**Reuse.** `mkNodeId/mkEdgeId`, `contributingIds`, `outputHash`, `hasCycle`,
`stableStringify`/`fnv1a`.

**Acceptance.** Factories produce conformant nodes; connecting a fluid/output/combine
into a combine slot keeps edges consistent; `validate`/`outputRenderable` reflect the
DAG; `outputHash` changes only when that output's contributing subgraph changes.

**Verification (two-audience).**
- *Agent:* `cd frontend && npm run test -- graphModel` — new cases: combine factory;
  connect video into a slot; add/remove slot; validate rejects stack→merge and a
  cycle; hash isolation (editing combine B doesn't change output A's hash).
- *User:* none yet (pure lib); confidence from green vitest + `npm run build`.

**Risks.** Slot-id stability across reload (like signal ids in `04` §3.8) — slots
carry stable ids; don't regenerate on hydrate.

---

## Step 4 — Frontend: Combine card + output passthrough + palette

**Goal.** A `CombineNode` card with a mode toggle, dynamic N video inputs, merge
medium vs. per-input opacity controls, one video out; the output's pass-through
port; `+ Combine` in the toolbar.

**Files.** `components/animation/nodes/CombineNode.jsx` (new), `OutputNode.jsx`
(add `sideOut` video port), `Palette.jsx` (`+ Combine`), `GraphCanvas.jsx`
(video→video into dynamic slots), `styles/animation.css`.

**Design.**
- `CombineNode`: header with mode toggle (`merge` / `stack`) + ✕ delete; a column of
  **input slots** (each a side `in` port + an opacity slider shown in `stack`, +
  a ✕ to remove the slot) and a `+ input` button; in `merge`, four medium `Ctl`
  rows (from the combine's `data.medium`); one side `out` video port. Accent a new
  hue (e.g. amber) to distinguish from fluid/output.
- `OutputNode`: add a `video` **out** port (passthrough) alongside its `in`.
- `Palette`: `+ Combine` (drops a combine at canvas center).
- `GraphCanvas`/`canConnect`: video out → combine slot / output in; combine out →
  combine slot / output in. Reuse the side-port placement + `flow:"video"` rules.

**Reuse.** `NodeFrame` (`sideIn`/`sideOut`/`onDelete`), `Port`, `Ctl`/`Toggle`,
the dynamic-port + delete patterns already in `FluidNode`/`OutputNode`.

**Acceptance.** Add a combine; switch modes; add/remove input slots; wire two fluids
(and an output passthrough) into it; wire the combine into an output; opacity sliders
appear in stack, medium controls in merge.

**Verification (two-audience).**
- *Agent:* `npm run build` + `npm run lint` green; vitest renders `CombineNode` and
  asserts ports/controls per mode.
- *User:* in the animation tab, build fluid→combine→output and wire a second fluid in;
  toggle merge/stack and watch the controls switch; ports wire cleanly.

**Risks.** Card height with N slots + medium rows — allow internal scroll / collapse
(reuse the fluid group-collapse). Edge re-anchoring when slots mount/unmount — call
`helpers.onLayoutChange` (as `FluidNode` does).

---

## Step 5 — Frontend: render integration + end-to-end

**Goal.** The per-output render drives the whole video DAG (combine in the middle),
with correct caching.

**Files.** `OutputNode.jsx` / `AnimationCanvas` ctx (mostly already generic —
`output_id` + `outputHash` now cover the DAG via Step 3).

**Design.** Confirm `OutputNode`'s debounced `renderGraph({…, output_id})` +
`outputHash` recompute correctly when an upstream combine or its inputs change; the
"renderable" gate uses the generalized `outputRenderable`.

**Acceptance.** Editing any node upstream of an output re-renders only that output;
unrelated pipelines untouched; merge and stack both preview in the output card and
loop/scrub on the shared transport.

**Verification (two-audience).**
- *Agent:* n/a beyond build; covered by Step 2 backend + Step 3 model tests.
- *User (headline demo):* `make dev` — make two fluids (drums kick + vocals), wire
  both into a **merge** combine → output: one clip where the two jets interact; flip
  the combine to **layered**, set the second input's opacity to ~0.4 → stacked clip
  with the top layer semi-transparent; add an `output` on one fluid and tap its
  pass-through into the combine. Reload → graph intact.

**Risks.** Stale-cache across the semantics change — bump the `render_version` (as in
`graph_hash`) when combine ships so old per-output clips are invalidated.

---

## Step 6 — Tests + docs

**Goal.** Lock the feature with tests and update the guide + README.

**Files.** `tests/test_graph_combine.py` (new), `tests/test_fluid_modulation.py`
(extend with multi-source), `frontend/src/__tests__/graphModel.test.js` (combine),
`frontend/src/components/Docs.jsx` (animation section), `README.md`.

**Design / acceptance.** Backend: multi-emitter interaction, merge param build,
alpha-over compositing (opacity affects output; overlap differs from a single
layer), output pass-through, `output_hash` isolation across pipelines, stack→merge
rejection. Frontend: combine model round-trip + validate + hash. Docs: a "Combining
fluids" subsection (merge vs layered, dynamic inputs, per-input opacity, output
pass-through) + README mention.

**Verification (two-audience).**
- *Agent:* `pytest -q`, `npm run test`, `npm run lint`, `npm run build`, `ruff check`
  all green.
- *User:* open the `?` guide → the combine subsection reads correctly; the e2e demo
  from Step 5 matches the docs.

**Risks.** Audio-dependent backend tests — mock `signals.extract` for emitter/merge
tests (as existing graph tests do); keep grids/durations tiny.

---

## v1 boundary & extension points

**In v1:** `combine` with `merge` | `stack`, dynamic N inputs, per-input opacity
(stack) + own medium (merge), output pass-through, alpha-over compositing, bg at
terminal. **Deferred (designed-for):** modulating combine params with signals;
more blend options; reordering layers by drag (v1 = input order); combine emitting
into another merge's medium beyond simple concat. The `resolve_video` /
`resolve_emitters` dispatch keeps these cheap to add.
