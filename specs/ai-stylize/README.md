# AI-Stylized Video Cards — design records (a HALF-EXECUTED plan)

> **Read this first.** This folder is filed under `specs/`, but unlike every other wave here
> it is **not** a record of finished work. Steps 0 and 2 shipped, step 5 shipped in part, and
> **steps 1, 3 and 4 were never built** — there is no code for them anywhere. The `Status`
> column below is the truth; the prose inside each step file is still written in the
> forward-looking voice it was drafted in, so do not read "we will" as "we did".

This folder breaks the [proposal](PROPOSAL.md) into self-contained,
executable steps. Each file is a full implementation plan for one step: goal, prerequisites,
files to touch (with real function names), a concrete build sequence, risks, an exit gate, and
verification. They were meant to be done **in order**, each gated on the last.

The source brief is [`BRIEF-image-video-gen.md`](BRIEF-image-video-gen.md) (diffusion feedback loops,
Workflow A/B, velocity warping, drift control). Read it once before Step 0.

| Step | File | Ships | Status |
|---|---|---|---|
| 0 | [`step-0-prototype.md`](step-0-prototype.md) | Standalone script proving the loop works on this Mac | **shipped** — `scripts/ai_stylize_prototype.py` |
| 1 | [`step-1-velocity-export.md`](step-1-velocity-export.md) | Sim velocity field captured + cached | **not built** — no velocity side-channel exists |
| 2 | [`step-2-aistylize-card.md`](step-2-aistylize-card.md) | The `AI Stylize` card, generate-on-demand | **shipped** — `backend/routes/stylize.py`, `StylizeNode.tsx` |
| 3 | [`step-3-drift-guards.md`](step-3-drift-guards.md) | LAB anchor, re-anchor, audio-reactive denoise | **not built** — `anchorEvery`/`reanchorEvery`/`noiseInject` exist nowhere; the `stylize` port spec has one port, `strength` |
| 4 | [`step-4-shapes-card.md`](step-4-shapes-card.md) | `Shapes` producer (circles/lines) + analytic motion | **not built** — no `shapes` card in `CARD_LABELS` or the frontend registry |
| 5 | [`step-5-quality-scope.md`](step-5-quality-scope.md) | Z-Image HD, depth, prompt crossfade, song continuity | **partly shipped** — 5A only: `imagegen.HD_MODEL` (Z-Image-Turbo) + `_regenerate_hd_stylize`. Depth conditioning, prompt crossfade and song continuity are not built |

One stale detail worth flagging rather than silently fixing: step 5 names a module
`backend/videostylize.py` that never existed — the card lives in `backend/routes/stylize.py`.

## Cross-cutting decisions (apply to every step)

- **Generation never runs in a render request.** It runs as a `jobs.py` job (single GPU worker),
  triggered by an explicit button, producing a **content-addressed clip** in `data/assets/`.
  Render handlers only *decode* that clip. This mirrors `imagegen` / `_regenerate_hd_images`.
- **Draft in editor, HD at export.** Same split as the Image gen card (SD-Turbo draft,
  Z-Image HD). Model is a card dropdown.
- **Serialize inference.** Reuse the `imagegen._infer_lock` discipline so a draft in the editor
  and an HD export regen can never run two pipes on MPS at once.
- **Everything diffusers is lazy + optional.** Import inside the worker, raise a clean message a
  job surfaces; the app boots and all non-AI cards work without the stack (the `imagegen.py`
  shape).

## Key existing code the steps build on (verified paths)

- `backend/imagegen.py` — `MODELS`, `_load_pipe`, `generate`, `_infer_lock`, `_pipes` (lazy singletons).
- `backend/routes/uploads.py:generate_image` + `_generate_assets` + `_store_asset` — the
  job/content-addressed-asset pattern to copy.
- `backend/fluid.py:FluidClip.advance` (lines ~500-514) — where `sim.u`/`sim.v` are live and dye
  is tonemapped; the velocity-capture hook.
- `backend/fluid_cache.py:frame_writer` / `load` / `store` / `params_hash` — the block-incremental
  cache to reuse for velocity.
- `backend/graph_render.py` — `_transform_video`/`_transform_block` (video→video precedent),
  `_video_block` (persistent decoder precedent), `Dag.video`/`_block_producer`/`_fx_params`/
  `_grid_dims`/`_video_source`, and the `_VIDEO_HANDLERS`/`_BLOCK_HANDLERS`/`_VIDEO_PRODUCERS`
  registries.
- `backend/animation_params.py:SOURCE_PARAM_SPEC` — the `transform` entry is the port-spec template.
- `backend/graph_hash.py` — `RENDER_VERSION`, `output_hash`.
- `frontend/src/lib/graph/factories.ts` (`GRAPH_VERSION`), `nodes/registry.ts` (`NODE_TYPES`),
  `components/animation/nodeInputs.ts` (edge inputs), `backend/card_demo.py` (`CARD_LABELS`).
