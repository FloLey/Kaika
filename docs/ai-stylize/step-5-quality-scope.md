# Step 5 — Quality & scope growth (optional / later)

**Goal:** raise output quality and broaden reach once the core (Steps 2–4) is proven and used.
Each item here is independent — pick by what the wedding video / real use actually needs. None
gates the others.

## Prerequisites

Steps 2–4 shipped and used on real content.

## 5A. Z-Image Turbo HD path

The export-quality tier, mirroring how the Image gen card regenerates HD at export
(`export.py:_regenerate_hd_images`).

- Add a Z-Image entry to `backend/videostylize.py`'s model registry (the `imagegen.HD_MODEL`
  `Tongyi-MAI/Z-Image-Turbo` is already loaded elsewhere with the right bfloat16/MPS handling —
  reuse that loader shape).
- ControlNet: **research update — Z-Image ControlNet now runs from Python**, no ComfyUI needed.
  `alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union-2.1` supports Canny/HED/Depth/Pose/Scribble;
  reference pipelines live in VideoX-Fun and DiffSynth-Studio (diffusers support tracked in
  huggingface/diffusers#12769; the doc's "ComfyUI only" note is stale).
- At export, the `/export/stream` job regenerates each `aistylize` clip with the HD model at export
  size before `song_render` runs — same content-addressed cache, HD key. Minutes/frame, so this is
  strictly the export pass, never the editor.

## 5B. Depth control mode

Add luminance-as-depth (and, later, a real depth estimator) as a `controlMode` option. Depth
conditions volume/relief where Canny conditions only edges — better for "cosmic clouds / molten
matter" looks. Z-Image Union and SD depth ControlNets both support it. Pure additive: one more
control-extraction branch in `stylize_clip` + one dropdown value.

## 5C. Prompt A→B crossfade

The Step 3 stretch, promoted: interpolate two prompt embeddings across a segment so the style
morphs. Requires passing `prompt_embeds` to the pipe and lerping per keyframe.

## 5D. Whole-song feedback continuity

Today generation is per segment; the feedback frame resets at each cut. For a seamless song,
carry the last generated frame across segment boundaries as the next segment's anchor — the way
`song_render.py` carries one persistent `FluidSim` per layer across cuts. Larger change (couples
segments in the export job); only worth it if cut-flicker is objectionable.

## 5E. Speed: TAESD + CoreML

- **TAESD / TinyVAE** (`AutoencoderTiny` in diffusers) decodes latents ~11× faster than the full
  VAE — a known img2img-loop accelerator, drop-in. First optimization if Step 0 flagged decode as a
  bottleneck.
- **CoreML UNet conversion** is (per research) the *only* effective UNet acceleration on Apple
  Silicon — SD-Turbo img2img hit ~14 fps at 512px on an M3 Ultra converted. Heavier lift (convert +
  a CoreML runtime path parallel to the diffusers path); reserve for when generation time is the
  binding constraint on real use.

## 5F. Real-time / StreamDiffusion (brief's Workflow C)

A live VJ/interactive mode. Conflicts with the block-render architecture (it wants a persistent
streaming pipe, not per-block generation), so it's a separate research spike, not an extension of
the card. Keep as a note.

## 5G. Watch item: full video-diffusion models

Wan 2.2 (MoE), LTX-2, HunyuanVideo give far stronger temporal coherence than a frame-by-frame
loop, but (2026) target 24 GB+ NVIDIA GPUs even quantized — not viable on MPS yet. Wan **VACE**-style
video-to-video with depth control is the thing to re-evaluate periodically; if a member of that
family becomes MPS-feasible, it could supersede the feedback loop entirely for the HD path.

## Risks

- **Z-Image memory** (~33 GB unified) — already handled by `imagegen`'s serialized single-inference
  discipline; keep it. Do not let an HD stylize and an HD image gen overlap (shared `_infer_lock`).
- **Scope** — this file is a menu, not a sprint. Ship one item, measure, decide the next.

## Verification

Per item, the same discipline as Steps 2–4: pytest for handler/cache/key behavior, `/verify` for
the visible result, `make test`/`lint`/`tsc`. HD path: confirm an export regenerates at HD and a
re-export with unchanged inputs reuses the HD clip (no regeneration).
