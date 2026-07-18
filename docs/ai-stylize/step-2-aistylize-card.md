# Step 2 — The `AI Stylize` card (minimum viable, generate-on-demand)

**Goal:** ship a real card. A `aistylize` video→video node that sits after any video producer,
runs the Step 0/1 loop on its upstream frames as a background job, caches the result as a
content-addressed clip, and plays that clip through the normal render/preview/export paths.

**Core architectural rule:** generation is **never** run inside a render request. A render handler
that took several seconds per frame would freeze the 4-worker render pool and every live preview.
Instead: an explicit **Generate** button → a `jobs.py` job (single GPU worker) → a content-addressed
clip on disk → cheap render handlers that only *decode* it. This is exactly the `imagegen` /
`export.py:_regenerate_hd_images` split, applied to video.

## Prerequisites

Steps 0 and 1 passed (working loop + model choice + velocity warp).

## The generation model (backend)

### New module `backend/videostylize.py`
Mirror `imagegen.py`'s shape: lazy per-model pipeline singletons, one global `_infer_lock`,
clean ImportError message. Core entry:

```
stylize_clip(frames, *, prompt, negative, denoise, control_mode, control_scale,
             model, seed, velocity=None, on_progress=None, should_cancel=None) -> np.ndarray
```

- `frames`: upstream `[T,h,w,3]` uint8 (grid or preview res). `velocity`: optional `[T,h,w,2]`.
- Runs the Step 0/1 loop: control extraction, img2img feedback, Workflow B warp when `velocity`
  given, LAB anchor match + fixed-noise per segment (from Step 0 findings).
- Reuse `imagegen._infer_lock` (import it, don't make a second lock) so a stylize job and an image
  ✨ can never run two pipes on MPS at once.
- `on_progress(done, total)` and `should_cancel()` — the `jobs.py` / `render_jobs.py` contract.
- Returns the stylized `[T,h,w,3]` uint8 clip (caller encodes/stores).

Model registry like `imagegen.MODELS`: a draft (SD-Turbo class, from Step 0) and, later (Step 5),
a Z-Image HD entry. Keep model choice a card dropdown.

### Keyframe + interpolation (cost control)
`stylize_clip` generates at a **keyframe fps** (card option, default 8–12) and interpolates up to
the segment's real fps. Start with ffmpeg `minterpolate` (`mi_mode=mci:mc_mode=aobmc:me_mode=bidir`)
— **zero new deps** — invoked around the encode, or interpolate frames in-array before encode.
Note RIFE as a later quality upgrade (Step 5).

### Content-addressed clip store
A stylized clip is expensive → cache it by *what determines it*, independent of the render-clip
hash (which is resolution-bound and won't carry between preview and export):

- Key = `sha1(upstream_frames_hash, prompt, negative, denoise_curve, control_mode, control_scale,
  seed, model, keyframe_fps, out_fps, size)`. The `upstream_frames_hash` is the upstream node's
  contributing hash (reuse the `graph_hash` backward-walk that `output_hash` already uses, or hash
  the actual upstream frame bytes for a preview).
- Store as an mp4 in `data/assets/` like `_store_asset` does for images
  (`stylized-<sha16>.mp4`). Identical regenerations dedupe; a re-export with unchanged inputs
  reuses the file. Register the asset kind so `backend/cache_gc.py:sweep()` treats it as reachable
  when referenced by a card (mirror how generated images are kept).

### The endpoint + job
A route `POST /stylize/<job_id>` (add the `/stylize` prefix to `frontend/vite.config.js` proxy —
**hard invariant**). It:
- Loads the project graph + segment, resolves the target `aistylize` node's upstream frames and
  (if the upstream is a fluid) its velocity cache, resolves the modulatable ports to curves.
- `jobs.submit(gen_job, "stylizing", lambda: _stylize_and_store(...))` — the single-worker pool,
  serialized with all other GPU work. Returns `{job_id}`; the card polls `GET /jobs/<id>` for
  `{state, step, error, result:{asset}}` (the `generate-image` pattern, `uploads.py:153`).
- Cancellable: the job checks `should_cancel()` between keyframes.

Store the resulting asset URL on the node's `data` (e.g. `data.clipUrl` + the key it was generated
for) so the render handlers and the UI know it's ready and whether it's stale.

## The render handlers (cheap — decode only)

Register `_aistylize_video` and `_aistylize_block` in `graph_render.py` `_VIDEO_HANDLERS` /
`_BLOCK_HANDLERS` (keep them in lockstep — a hard invariant). Both:

1. Resolve the upstream via `_video_source(dag.graph, node["id"], "video")`.
2. If `data.clipUrl` exists **and** its stored key matches the current inputs → **decode** the
   generated clip using the `sources.VideoClip` decoder, exactly like `_video_video` /
   `_video_block` (`graph_render.py:900` is the persistent-decoder template). Place it at
   `_grid_dims(dag)` and `dag.fps`, RGBA like other layer sources.
3. If absent or **stale** → **pass the upstream frames through unchanged** (`dag.video(src)` /
   `dag._block_producer(src)`), so previews, exports, and `test_card_impact` never block on the GPU
   or 400. The card shows a "not generated / stale — click Generate" badge.

This "decode-if-present-else-passthrough" keeps the expensive path entirely out of rendering.

## The card (frontend — DEVELOPMENT.md checklist)

1. **Types** (`lib/types.ts`): add `"aistylize"` to `NodeType`; a `AIStylizeData` interface
   (prompt, negative, controlMode, model, seed, keyframeFps, interpolate, clipUrl?, clipKey?, plus
   the `ports` bag); a `GraphNode` union member.
2. **Factory** (`lib/graph/factories.ts`): `aiStylizeNode(x, y)` seeding defaults +
   `ports: coercePorts("aistylize", undefined)`. Add a `normalize.ts` `DATA_SCHEMAS` row; the
   persisted shape is new → **bump `GRAPH_VERSION`** + a `normalizeGraph` migration.
3. **Component** (`components/animation/nodes/AIStylizeNode.tsx`): built on `NodeFrame`, a video
   edge input (via `nodeInputs.ts`), the static controls (prompt/negative textareas, control-mode +
   model dropdowns, seed, keyframe fps), a **Generate** button wired to `/stylize/<job_id>` with a
   progress/badge state, and a `StreamPreview` showing the rendered output (passthrough until
   generated). Register in `nodes/registry.ts` `NODE_TYPES` with `chrome{outFlow:"video"}`,
   `factory`, and a `palette` entry.
4. **Inputs** (`components/animation/nodeInputs.ts`): declare the `{portId:"video", flow:"video",
   kind:"edge"}` input (the `transform` card is the template) plus the modulatable param inputs.
5. **Ports** (`backend/animation_params.py:SOURCE_PARAM_SPEC`): add an `"aistylize"` entry — the
   `"transform"` block is the exact template. Ports: `denoise` (0.2–0.7, def 0.45),
   `controlStrength` (0–1, def 0.8), `noiseInject` (0–0.5, def 0.0). Run `make gen-params` to
   regenerate `frontend/src/lib/fluidParams.js` (never hand-edit; `test_fluid_params_codegen`
   guards it). These ports become audio-reactive for free via the binding system.
6. **Help + docs**: a `lib/paramHelp.ts` entry for each modulatable port (its test FAILS on a port
   without help); an `ui/Info.tsx` "?" for the static controls with a `section` added to
   `Docs.tsx` `DOC_SECTION_IDS`; prose in `Docs.tsx` describing the card.
7. **Playground** (`backend/card_demo.py:CARD_LABELS`): add the `aistylize` label (**never exclude
   a card**). Build a demo pipeline in the live Playground (tiny fluid → aistylize → output, a
   one-word prompt, draft model, pre-generated so the clip exists), then `make export-playground`
   to capture it into `playground_pipelines.json` (never hand-edit). `test_card_impact` renders it
   and fails if the card doesn't contribute / the clip is black.

## Docs to update (part of the deliverable)

- `ARCHITECTURE.md`: the new `videostylize.py` module, the content-addressed stylized-clip store,
  and the `cache_gc.py` reachability for the new asset kind.
- `README.md`: the `/stylize` route + the `data/assets/stylized-*.mp4` storage.
- `Docs.tsx`: the user-guide section (already added in step 6 above).
- If the velocity cache from Step 1 becomes render-visible now, **bump `RENDER_VERSION`**
  (`graph_hash.py`) — the stylized output IS render-visible, so bump it.

## Risks

- **Preview cost.** Even decode-only, each on-screen card triggers a preview stream (2-slot cap in
  `useStreamRender.ts`). The passthrough default means an *ungenerated* card is as cheap as
  `transform`; only decoding a generated clip adds work (cheap). Good.
- **Staleness correctness.** If the user edits the prompt/upstream after generating, the render
  must NOT show the old clip silently. Mitigation: store `clipKey` and compare against the live
  input hash in the handler; mismatch → passthrough + "stale" badge. This is the subtle bug to test.
- **Job ↔ render race.** Generation on `jobs.py` (1 worker) and a render on `render_jobs.py`
  (4 workers) can overlap; the shared `_infer_lock` protects the GPU, and the render handler never
  generates, so they don't fight.
- **GRAPH_VERSION / RENDER_VERSION bumps** — easy to forget; both are required here.

## Exit gate

In the app: drop a fluid → AI Stylize → output chain, set a prompt, click Generate, watch progress,
see the stylized clip play in the card preview and in the segment render, and run a **segment
export** that reuses the same generated clip (no regeneration). The Playground demo renders
non-black.

## Verification

- pytest: `_aistylize_video`/`_aistylize_block` lockstep + passthrough-when-absent + decode-when-
  present + stale-key → passthrough; stylized-clip key stability; job lifecycle
  (submit→poll→result); `test_card_impact` + `test_graph_registry`.
- vitest: `registry.test.tsx` round-trip, `playgroundFixture.test.ts`, the card component's
  Generate-button state machine.
- `make gen-params` clean, `make lint`, `npx tsc --noEmit`.
- `/verify` skill: drive the wire→generate→preview→export flow in the real app.
