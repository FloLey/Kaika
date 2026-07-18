# AI-Stylized Video Cards — proposal

Companion to [`Image_video_gen.md`](Image_video_gen.md) (the technical brief on diffusion
feedback loops over fluid-sim frames). This document maps that brief onto Kaika's card
architecture, adds web-research findings (2026-07), proposes concrete cards, and lays out a
phased implementation plan. Status: **proposal — nothing here is implemented yet.**

> **Per-step implementation plans:** [`ai-stylize/`](ai-stylize/README.md) breaks the phases
> below into one detailed, executable `.md` per step (goal, files, build sequence, risks, exit
> gate, verification).

## Goal

Generate AI-stylized image/video from *shape-producing* cards: today the fluid simulation,
later parametric shape cards (circles, lines, …). Each generated frame follows the shape's
form (ControlNet) and chains coherently to the previous frame (img2img feedback loop,
velocity-field warping).

## Why this fits Kaika unusually well

1. **The diffusion stack already exists.** `backend/imagegen.py` loads SD-Turbo (draft) and
   Z-Image Turbo (HD) on MPS with lazy per-model singletons and a global `_infer_lock`. Adding
   an img2img + ControlNet pipeline is a new entry in the same module, not new infrastructure.
2. **The velocity field is computed and thrown away.** `FluidSim` keeps `u`/`v` across steps but
   `FluidClip.advance()` (`backend/fluid.py`) only captures the tonemapped dye. One hook there
   exports exact per-frame motion (~260 KB/frame at grid res) — the brief's "information en or"
   that tools like Deforum can only *estimate* via optical flow. We have it exactly.
3. **A video→video card slot exists.** The `transform` card (`_transform_video`/`_transform_block`
   in `backend/graph_render.py`) is the precedent: a `flow:"video"` edge input, frames pulled via
   `dag.video(src)`. An AI card built this way styles *anything* — fluid, lyrics, combine stacks,
   and any future shape card.
4. **The expensive-asset pattern exists.** imagegen generates content-addressed assets on the
   single-worker `jobs.py` pool: draft quality in the editor, HD regenerated at export
   (`export.py:_regenerate_hd_images`). A slow video generator must follow the same split — the
   render caches (`output_hash`, `params_hash`) are resolution-dependent and won't carry work
   between preview and export; a content-addressed generated-clip store will.
5. **Modulation is free.** Any port declared in `SOURCE_PARAM_SPEC` becomes audio-reactive via
   the existing binding system — so *denoise strength driven by the music* (the brief's
   "strength_schedule") is a one-spec-line feature, and a uniquely Kaika one.

**Cost reality (drives the whole design):** SD-Turbo img2img at 512px ≈ 0.5–1.5 s/frame on MPS;
Z-Image ≈ minutes/frame. A 3-min song at 24 fps = 4 320 frames → hours. Mitigations baked in:
generate at low internal resolution, generate keyframes at reduced fps (8–12) and interpolate
(ffmpeg `minterpolate`, later RIFE), per-segment (not whole-song) generation, strict draft/HD
split, explicit Generate button (never auto-render the model).

## Web research findings (2026-07)

- **Z-Image Turbo ControlNet works from Python now** — the brief's "ComfyUI only" note is
  outdated. `alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union-2.1` ships Canny/HED/Depth/Pose/
  Scribble control with reference Python pipelines in VideoX-Fun and DiffSynth-Studio
  (diffusers support tracked in huggingface/diffusers#12769). The HD path stays in Python.
- **Speed ceiling on Apple Silicon is fine for keyframes**: SD-Turbo img2img reaches ~14 fps at
  512px with CoreML conversion on an M3 Ultra (arXiv 2605.16259); plain PyTorch-MPS is several×
  slower but still ~1 s/frame territory. CoreML conversion is the *only* effective UNet
  acceleration on Apple Silicon (CUDA-style quantization doesn't help) — a later lever.
- **Full video-diffusion models are not the Mac-local answer (yet)**: the 2026 open leaders
  (Wan 2.2 MoE, LTX-2 19B, HunyuanVideo) target 24 GB+ NVIDIA GPUs even quantized. Wan
  VACE-style video-to-video with depth control is the long-term watch item; the brief's
  frame-by-frame turbo loop is the right local architecture today.
- **Flicker research validates Workflow B and adds cheap tricks**: ReRender-style pipelines get
  coherence from exactly our combo (flow warping + ControlNet); StreamDiffusion reduces flicker
  by **reusing the same noise vector for every frame** — free to adopt (fixed seed/noise per
  segment); cross-frame attention is the heavier future option.

## Card ideas

### 1. `AI Stylize` card (video→video) — the core card
Sits after any video producer; per segment, runs the brief's feedback loop: control image
extracted from upstream frames (Canny / soft-edge / luminance-as-depth / raw), img2img from the
previous generated frame, prompt + negative prompt.
- Modulatable ports: `denoise` (0.2–0.7, def 0.45), `controlStrength`, `noiseInject`.
- Static: prompt, negative prompt, control mode, model (draft/HD), seed, anchor-image option,
  keyframe fps + interpolation toggle.
- Workflow A (no warp) first to validate; Workflow B (velocity warp) when upstream provides
  motion. Anti-drift from day one: LAB color match to the anchor frame every N frames +
  periodic re-anchor (cheap OpenCV ops).

### 2. Velocity as a first-class side-channel ("motion" flow)
Capture `u`/`v` in `FluidClip.advance()`, cache alongside dye frames via a second
`fluid_cache.frame_writer` (`<key>.vel.npy`, same `params_hash`). The Stylize card warps its
feedback frame with `cv2.remap` when motion is available. Design the interface so *any*
producer may export motion: shape cards supply **analytic** velocity (an expanding circle's
flow field is known in closed form — better than the sim's), `transform` can compose motion
through pan/zoom/rotate later. Non-providers fall back to Workflow A (optionally Farnebäck
optical flow estimated from frames).

### 3. `Shapes` card family (video producers = ideal control images)
Parametric shape renderers producing RGBA frames — normal visual layers *and* clean ControlNet
inputs (crisp edges beat noisy dye contours):
- N circles/rings/lines/polygons placed via the existing `points`/`pattern` cards (reuse
  `_pattern_points` layouts: circle, ring, grid, line, spiral, scatter), with modulatable
  radius/thickness/count → beat-pulsing geometry for free.
- Analytic velocity export per idea 2.
- Later: waveform/spectrum renderer, boids/particles. Each follows the lyrics-card precedent —
  valuable standalone, superpowered behind AI Stylize.

### 4. Audio-reactive generation parameters (the differentiator)
No new card — falls out of 1+3 via the binding system: denoise bound to onset/energy signals
(calm = stable texture, drops = re-invention bursts), controlStrength bound to a signal, prompt
A→B crossfade over a segment (embedding interpolation; stretch goal). No off-the-shelf
Deforum/ComfyUI setup offers segment-signal-driven diffusion.

### 5. Real-time / StreamDiffusion (brief's Workflow C) — later wave
Live VJ-style preview. Conflicts with the block-render architecture; research note only.

## Implementation plan (phased; each phase ships something usable)

**Phase 0 — standalone prototype (de-risk first).** Script loading cached fluid frames from
`data/fluid_cache/*.npy`, running the brief's §8 loop with SD-Turbo + Canny ControlNet on MPS,
writing an mp4. Measure s/frame at 512px, memory, flicker with/without LAB matching, denoise
sweep (0.3/0.45/0.6), fixed-noise-per-segment trick. Verify a ControlNet compatible with
sd-turbo (SD 2.1 base) exists — fallbacks: SD 1.5 + LCM-LoRA, or SDXL-Turbo +
`controlnet-canny-sdxl`. **Gate: a 10-s clip looks good and costs < ~2 min at draft quality.**

**Phase 1 — velocity export + warp validation.** Hook in `FluidClip.advance()`, second
`frame_writer` cache gated behind a flag; extend the prototype to Workflow B and calibrate flow
scale/sign visually. **Gate: warp visibly reduces flicker at equal denoise.**

**Phase 2 — `AI Stylize` card, minimum viable.** Full DEVELOPMENT.md card checklist (types,
factory, registry, nodeInputs video edge, `SOURCE_PARAM_SPEC` ports + `make gen-params`,
paramHelp + Docs.tsx, `CARD_LABELS` + Playground pipeline, `_aistylize_video` +
`_aistylize_block` in lockstep). Generation is **not** inline in the render pool: an explicit
Generate button submits a `jobs.py` job (single worker, serialized GPU, cancellable, polled via
`GET /jobs/<id>`); output is a content-addressed clip in `data/assets/` keyed by
sha1(upstream-frames hash, prompt, denoise curve, control mode, seed, model, fps, size) —
shared across preview and export. Render handlers just decode the generated clip (`VideoClip`
precedent); if absent, pass upstream frames through with a "not generated yet" badge so
previews and `test_card_impact` never block on the GPU. HD path mirrors
`_regenerate_hd_images` at export. Update ARCHITECTURE.md (module, clip store, `cache_gc.py`
reachability for the new asset kind), README, Docs.tsx.

**Phase 3 — drift guards + audio-reactive polish.** LAB anchor matching + periodic re-anchor as
card options; signal-bound `denoise`/`controlStrength` sampled per generated keyframe;
`noiseInject`.

**Phase 4 — `Shapes` card.** New video producer per idea 3, points/pattern placement,
modulatable geometry, analytic velocity export, Playground demo, docs.

**Phase 5 (later) — quality & scope.** Z-Image Turbo + ControlNet Union 2.1 HD path
(Python-native), depth control mode, prompt crossfade, whole-song feedback continuity across
segment cuts (like `song_render` carries the sim), CoreML UNet conversion, StreamDiffusion
experiment, watch Wan VACE-class models for MPS viability.

## Open decisions

- **First model**: settled by Phase 0 measurements; keep model a card dropdown like imagegen.
- **Generation trigger**: explicit Generate button (predictable cost) over auto-on-edit;
  revisit after Phase 2.
- **Interpolation**: start with ffmpeg `minterpolate` (zero new deps); evaluate RIFE later.
