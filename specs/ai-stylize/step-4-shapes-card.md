# Step 4 — The `Shapes` card (circles, lines, … as control-image generators)

**Goal:** the user's explicit ask — a card that "makes circles appear, or lines" — as a first-class
video producer. Valuable standalone (a clean geometric layer), and the *ideal* input to AI Stylize:
crisp analytic edges make far better ControlNet conditioning than noisy dye contours, and shapes
can export **analytic** velocity (an expanding circle's flow field is known in closed form — better
than the sim's numeric field).

This step also proves the Step 1/2 "motion side-channel" generalizes beyond the fluid sim.

## Prerequisites

Steps 1–2 (velocity interface + AI Stylize card decode/passthrough) shipped. Can be built in
parallel with Step 3.

## Design

A `shapes` node: `outFlow: "video"`, a new **video producer** (like `backdrop` — synthesizes
RGBA frames from parameters, no upstream video). It reuses the existing points/pattern machinery
for *placement* so we don't reinvent layout:

- **Placement:** consume the `points`/`pattern` flow (the `_pattern_points` layouts already exist:
  circle, ring, grid, line, spiral, scatter — `graph_modulators.py`). A `shapes` node has a
  `points` input like a fluid does; each point is a shape center.
- **Shape kind (static):** circle / ring / line / polygon(n) / rect.
- **Modulatable ports:** `radius`, `thickness`, `count` (or per-shape `scale`), `opacity`, maybe
  `rotation`. Registered in `SOURCE_PARAM_SPEC` (the `transform`/`backdrop` entries are templates)
  → audio-reactive for free (radius pulsing to the kick, etc.).
- **Render:** draw with `cv2.circle`/`cv2.line`/`cv2.polylines` onto an RGBA grid-res frame at
  `_grid_dims(dag)`, per frame, sliced per block. Fill vs outline is the ControlNet knob — outline
  mode = a ready-made "canny-like" control image.

## Handlers

`_shapes_video` and `_shapes_block` in `graph_render.py`, registered in `_VIDEO_HANDLERS` /
`_BLOCK_HANDLERS` (lockstep). Pattern is `_backdrop_video`/`_backdrop_block` (a pure synthesizer
slicing per-frame param arrays from `dag._fx_params(node)`), plus the points resolution a fluid
does (`dag._resolve_points`). Output RGBA `[T,gh,gw,4]` uint8.

## Analytic velocity export (generalize Step 1's interface)

Step 1 established that a producer *may* offer a motion field. Give `shapes` an analytic one:

- A growing circle of radius `r(t)` centered at `c` has radial surface velocity `dr/dt` in the
  outward direction → a closed-form `(u, v)` field per pixel. A translating line → constant
  translation field. Compute these directly from the port curves (no solver, no estimation).
- Expose them through the **same cache/interface** the AI Stylize card reads (Step 2): when
  `aistylize`'s upstream is a `shapes` node, it warps with this analytic field. Define a small
  "motion provider" contract: a producer can register a `<key>.vel.npy` (or an in-memory field)
  keyed like its frames. Fluid (Step 1) and shapes (here) are the first two providers; `transform`
  and `combine` can join later.
- Non-providers still fall back to Workflow A (or estimated optical flow), so the AI card stays
  general.

## Full card checklist (same as Step 2)

types.ts + factory (+`GRAPH_VERSION` bump + migration) + `AIShapesData` + component
(`ShapesNode.tsx`, on `NodeFrame`, with a `points` input + `StreamPreview`) + `registry.ts` +
`nodeInputs.ts` (points input + param inputs) + `SOURCE_PARAM_SPEC` + `make gen-params` +
`paramHelp.ts` + `Docs.tsx` + `CARD_LABELS` + Playground demo (`make export-playground`).
Bump `RENDER_VERSION` (new render-visible producer).

## Risks

- **Scope creep** — waveform/spectrum/boids renderers are tempting; ship circles/rings/lines/
  polygons first, list the rest as follow-ups.
- **Placement coupling** — reusing points/pattern is a win but means the `shapes` demo needs a
  points/pattern upstream in the Playground; bundle it.
- **Analytic velocity units** must match the fluid's convention (cells/frame on the grid) so the AI
  card's warp scale/sign calibration (Step 1) is shared, not re-tuned per provider.

## Exit gate

A `Shapes` card renders non-black pulsing geometry standalone in the Playground; wiring it into AI
Stylize and generating produces a coherent stylized clip whose motion tracks the shapes (analytic
warp working). Radius bound to a kick signal visibly pulses.

## Verification

- pytest: `_shapes_video`/`_shapes_block` lockstep + non-black output; analytic velocity field has
  the expected direction for a growing circle / translating line; `test_card_impact` +
  `test_graph_registry`.
- vitest: registry round-trip, playground fixture, component.
- `make gen-params` / `make test` / `make lint` / `tsc`.
- `/verify`: Shapes standalone + Shapes→AI Stylize in the app.
