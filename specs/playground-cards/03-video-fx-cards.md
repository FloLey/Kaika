# 03 — Video post-FX cards (`video → video`)

> Every pixel in the playground comes from the fluid sim — there's no stage to
> transform or recolour a rendered stream. These two cards add a `video → video`
> post-FX layer that drops between any producer (fluid / combine) and the output:
> **Transform/Kaleidoscope** (pan/zoom/rotate/mirror) and **Color/Hue** (recolour).
> This is where the "music-video" look lives, and it's feasible because the renderer
> already does per-frame NumPy frame ops — `composite` (alpha-over) and
> `_tonemap`/`apply_background` are the exact pattern these reuse.

## Locked decisions

1. **Frames are `(T, H, W, 3)` uint8 RGB, dye-on-black** — the shape `simulate`
   returns and `composite` consumes (`graph.py:124-137`, `fluid.py:419`). Coverage
   (alpha) is **per-pixel max-channel brightness** (`composite` §); FX must **keep
   black black** so downstream transparency/compositing still works. An FX that would
   lift the floor (e.g. brightness offset) is therefore disallowed in v1.
2. **FX register in `_VIDEO_HANDLERS` only — never `_EMITTER_HANDLERS`.** They produce
   frames, not emitters, so they **cannot feed a merge combine** (a merge needs raw
   emitters). `isEmitterSource` already returns false for non-fluid/combine/output
   types (`graphModel.ts:223-248`), so this is the default — just don't add an emitter
   handler. They *can* feed an output or a **stack** combine.
3. **Modulatable params reuse the fluid port/binding model (PLAN P2).** Each FX
   declares a per-card param spec in the `FLUID_PARAM_SPEC` shape and stores
   `data.ports[key].binding`; the frontend reuses the range-slider UI and
   `connect`/`disconnect` verbatim, the backend resolves via the shared `resolve_ports`.
4. **Reuse existing frame machinery.** Geometric warps use
   `scipy.ndimage.map_coordinates` — the same backtrace `fluid._advect` already uses
   (`fluid.py:203-213`). No new dependency.
5. **Category `compositing`** (alongside `combine`), `outFlow: "video"`. They are added
   to the frontend `VIDEO_PRODUCERS` set (`graphModel.ts:152`) and, by virtue of a
   `_VIDEO_HANDLERS` entry, to backend `_VIDEO_PRODUCERS` — so `validate` accepts them
   feeding an output.

## Architecture this builds on

- Backend: `graph.py` `_Dag.video` + `_VIDEO_HANDLERS` (`graph.py:587-671`) — the
  dispatch to extend; `_video_source` (find a node's wired input); `_combine_video`
  (the closest template: read input(s) via `dag.video`, apply a NumPy op, return
  frames). `fluid.py` `composite`, `_tonemap`, `apply_background`, and the
  `map_coordinates` advection.
- Frontend: `CombineNode.tsx` (closest template — a video-in/video-out card with
  controls), `registry.ts` (`compositing` category, accent), `graphModel.ts`
  (`connectVideo`, `videoSource`, `VIDEO_PRODUCERS`, the fluid `connect`/`disconnect`
  reused for modulatable ports), `ports.ts` (`video` flow matches).
- P2 `resolve_ports` (PLAN) for per-frame param arrays.

## Cards

### C1 — Transform / Kaleidoscope  (`id: transform`)
1. **Purpose.** Pan, zoom, rotate, mirror, or kaleidoscope the stream — reactive motion
   on top of the fluid (spin the whole frame on the beat).
2. **Ports.** Input `video`. Output `out` (`video`). Modulatable `value` ports:
   `zoom`, `rotate`, `pan_x`, `pan_y`.
3. **Static params.** `mode`: `transform | mirror | kaleidoscope`. `segments`
   (kaleidoscope, 2–12). `wrap` (edges loop or clamp). Modulatable: `zoom` (0.5–2),
   `rotate` (0–360°), `pan_x`/`pan_y` (−0.5–0.5).
4. **Frontend.** `TransformData { mode; segments; wrap; ports }`. Component: mode select
   + segments + range sliders (reusing the fluid param sliders).
5. **Backend.** `_VIDEO_HANDLERS["transform"]`: `dag.video(src)`, resolve ports (P2),
   per-frame build a sampling grid (`map_coordinates`) for the affine; for
   kaleidoscope, fold polar angle into one wedge and mirror. Keep black black (sample
   outside → 0).
6. **Docs.** `animation-transform` — "Spin, zoom, or kaleidoscope the video; wire
   rotate to a signal."

### C2 — Color / Hue grade  (`id: color`)
1. **Purpose.** Recolour the stream — rotate hue, push saturation/contrast, invert,
   posterise — independently of the fluid's r/g/b (so you can sweep hue on a finished
   merge).
2. **Ports.** Input `video`. Output `out` (`video`). Modulatable: `hue` (0–360°),
   `saturation`, `contrast`.
3. **Static params.** `invert` (bool), `posterize` (0 = off, else 2–16 levels).
   Modulatable `hue`/`saturation`/`contrast`.
4. **Frontend.** `ColorData { invert; posterize; ports }`.
5. **Backend.** `_VIDEO_HANDLERS["color"]`: vectorised RGB↔HSV (numpy), rotate H, scale
   S, apply contrast about 0 (**not** 0.5 — preserves the black floor), optional invert
   (`1−x` only where covered, to avoid turning the black background white — clamp by
   the max-channel mask) and posterise. Per-frame params from P2.
6. **Docs.** `animation-color` — "Hue-rotate and grade the video; wire hue to a slow
   LFO for a colour sweep."

## Open questions (resolve while drafting)

- **Param spec storage.** Confirm per-card specs can live beside `FLUID_PARAM_SPEC`
  without tripping the codegen test (`tests/test_fluid_params_codegen.py` asserts the
  *fluid* spec ↔ `fluidParams.js`); these are separate tables, so they shouldn't — but
  verify before adding.
- **Sim resolution vs. FX cost.** FX run at the sim grid (64–144 short side), upscaled
  at encode (`render_mp4`). Confirm transforms look acceptable at sim res, or whether FX
  should run post-upscale (heavier). v1: run at sim res.
- **Black-floor invariant.** Each FX must be checked to preserve dye-on-black so
  `composite`/`apply_background` stay correct; add a test asserting an all-black input
  stays all-black through each FX (except where intentionally not, e.g. Color invert —
  document the exception).

## Verification

- `fluid → transform(kaleidoscope 6) → output` and
  `merge-combine → color(hue from LFO) → output` each render an mp4.
- Wiring an FX into a **merge** combine fails `validate` (frontend + backend); wiring
  into a **stack** combine or an output succeeds.
- Black-floor test: an all-black clip stays all-black through Transform/Color (Color
  invert is the documented exception).
- A static-param FX graph hits the render cache on a second render.
