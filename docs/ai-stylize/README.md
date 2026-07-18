# AI-Stylized Video Cards — implementation steps

This folder breaks the [proposal](../AI_stylize_cards_proposal.md) into self-contained,
executable steps. Each file is a full implementation plan for one step: goal, prerequisites,
files to touch (with real function names), a concrete build sequence, risks, an exit gate, and
verification. Do them **in order** — every step has a gate that must pass before the next starts.

The source brief is [`../Image_video_gen.md`](../Image_video_gen.md) (diffusion feedback loops,
Workflow A/B, velocity warping, drift control). Read it once before Step 0.

| Step | File | Ships | Gate |
|---|---|---|---|
| 0 | [`step-0-prototype.md`](step-0-prototype.md) | Standalone script proving the loop works on this Mac | 10-s clip looks good, < ~2 min at draft |
| 1 | [`step-1-velocity-export.md`](step-1-velocity-export.md) | Sim velocity field captured + cached | Warp visibly beats no-warp at equal denoise |
| 2 | [`step-2-aistylize-card.md`](step-2-aistylize-card.md) | The `AI Stylize` card, generate-on-demand | Wire → Generate → preview → export end-to-end |
| 3 | [`step-3-drift-guards.md`](step-3-drift-guards.md) | LAB anchor, re-anchor, audio-reactive denoise | Onset-bound denoise re-keys and reacts |
| 4 | [`step-4-shapes-card.md`](step-4-shapes-card.md) | `Shapes` producer (circles/lines) + analytic motion | Shapes demo renders non-black; feeds Stylize |
| 5 | [`step-5-quality-scope.md`](step-5-quality-scope.md) | Z-Image HD, depth, prompt crossfade, song continuity | Per-feature; optional/later |

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
