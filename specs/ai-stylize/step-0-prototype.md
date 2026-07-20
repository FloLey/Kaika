# Step 0 — Standalone prototype (de-risk the whole feature)

**Goal:** prove, outside the app, that the diffusion feedback loop from
[`BRIEF-image-video-gen.md`](BRIEF-image-video-gen.md) §8 produces a good-looking, coherent, affordable
clip on *this* Mac. Everything downstream (a card, jobs, caches, UI) is wasted effort if the
model/quality/speed economics don't hold. This step commits **no** app code — just a script and a
findings note.

**Why first:** the single biggest unknown is "does an SD-Turbo-class model + ControlNet at
~512px on MPS look good and run fast enough per frame." Settle it before building anything.

## Prerequisites

- The diffusers stack already used by `imagegen.py` (`pip install -r requirements.txt`).
- At least one rendered fluid clip so `data/fluid_cache/*.npy` has real frames to feed the loop.
  (Render any segment in the app once, or call `fluid.simulate` directly.)

## What to build

A script `scripts/ai_stylize_prototype.py` (not imported by the app; `scripts/` is fine for
throwaway tooling). It:

1. **Loads source frames.** Read a `data/fluid_cache/<key>.npy` array (`[T,h,w,3]` uint8,
   grid-res, dye-on-black) via `np.load(..., mmap_mode="r")`. Upscale each frame to the working
   resolution (512 on the short side, aspect-preserved) with `cv2.resize` (nearest, to match the
   app's crisp upscale).
2. **Builds the pipeline** following `imagegen._load_pipe`'s device/dtype logic
   (`device = "mps" if torch.backends.mps.is_available() else "cpu"`, `float16` on MPS):
   `StableDiffusionControlNetImg2ImgPipeline.from_pretrained("stabilityai/sd-turbo",
   controlnet=ControlNetModel.from_pretrained(<canny checkpoint>))`.
3. **Implements the loop** exactly as the brief §8:
   - `extract_control(frame)` → Canny edges (the brief's function).
   - Frame 0: high-strength img2img from the raw dye (no previous frame yet) = the anchor.
   - Frames 1..N: `pipe(prompt, image=prev, control_image=canny(frame_t), strength=DENOISE,
     num_inference_steps=2, guidance_scale=0.0, controlnet_conditioning_scale=0.8)`.
   - `prev = out`.
4. **Encodes** with the same ffmpeg invocation Kaika uses (`fluid.render_mp4` args, or a direct
   `ffmpeg -framerate 24 -i frame_%05d.png ...`).

## Experiments to run (this is the actual deliverable)

Produce a short findings note (`scripts/ai_stylize_findings.md` or append to the proposal):

- **s/frame + memory** at 512px, SD-Turbo, 2 steps. Compare 384/512/640.
- **Denoise sweep** 0.30 / 0.45 / 0.60 — pick the "structure follows, identity holds" zone the
  brief describes (§10). Record which value reads best on this content.
- **LAB color match** (brief §11 `match_colors_lab`) every 10 frames, on vs off — does it stop
  the palette drifting?
- **Fixed noise per segment** (StreamDiffusion finding: reuse one `torch.Generator` seed / noise
  latent for every frame) on vs off — does it reduce flicker for free?
- **Control modes**: Canny vs soft-edge vs luminance-as-depth — which conditions the fluid form
  best without over-constraining the style.

## Model / ControlNet risk (the main thing this step settles)

SD-Turbo is **SD 2.1-based**, so it needs a **2.1** ControlNet — the common `lllyasviel/*` canny
checkpoints are SD 1.5. Candidates, in order of preference to try:

1. `thepowefuldeez/sd21-controlnet-canny` (SD 2.1 canny) with `stabilityai/sd-turbo`.
2. **Fallback A:** SD 1.5 + LCM-LoRA (few-step) + `lllyasviel/sd-controlnet-canny` — very mature
   ControlNet ecosystem, slightly more steps.
3. **Fallback B:** `stabilityai/sdxl-turbo` + `diffusers/controlnet-canny-sdxl-1.0` — best
   ControlNet maturity, but SDXL is heavier on MPS (measure s/frame carefully).

Confirmed from research: SD-Turbo img2img is designed for `num_inference_steps` 1–4,
`guidance_scale=0.0`, `strength≈0.5` — exactly our regime. The open question is purely *which
ControlNet checkpoint pairs cleanly*; the prototype answers it empirically.

**Speed lever to note (not required in Step 0):** TinyVAE/TAESD decodes latents ~11× faster than
the full VAE and is a drop-in `AutoencoderTiny` in diffusers — a known img2img-loop accelerator.
Record whether decode is a bottleneck; if so, TAESD is the first optimization in Step 2/5.

## Risks

- **ControlNet checkpoint mismatch** → blurry or ignored structure. Mitigation: the 3-way
  fallback above; the prototype's whole job is to find the working pair.
- **MPS float16 instability** (NaNs) → `imagegen` already runs float16 on MPS successfully, so the
  base model is fine; watch the ControlNet module specifically.
- **Too slow** (> a few s/frame) → drop resolution, adopt TAESD, or accept keyframe+interpolate
  (Step 2) as the plan already assumes.

## Exit gate

A 10-second (≈240-frame) clip that (a) visibly follows the fluid form, (b) doesn't strobe, and
(c) renders in **under ~2 minutes** at draft settings. Plus a findings note fixing: the model +
ControlNet pair, the default denoise, and whether LAB-match / fixed-noise are worth keeping.

**If the gate fails**, stop and reconsider (heavier model, cloud generation, or shelve) before
Step 1 — do not build app integration on an unproven loop.

## Verification

Purely manual for this step: eyeball the mp4s, read the timing table. No pytest/vitest (nothing
in the app changed). Keep the script and note in the repo (or scratchpad) for reference by Step 2.
