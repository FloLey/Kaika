# 01 — Inference core: pure txt2img + control, and the embedding lerp

> **Status: BUILT.** `imagegen.dream_frames` / `_dream_embeds` / `_stylize_pipe_key`,
> `tests/test_dream.py` (17), `scripts/dream_lerp_probe.py`.
>
> **The lerp verdict — the open question this wave was built around.** Both models hold
> endpoint parity (w=0 and w=1 are byte-identical to a plain single-prompt render), and
> **neither produces mud**: every midpoint is a coherent image, so the worry about
> Z-Image's causal encoder was unfounded. But the two models interpolate very differently,
> and only one of them fades:
>
> - **SD-Turbo (draft): a true gradual morph.** Snowy mountains → an intermediate sphere →
>   a lava field, changing steadily across the whole 0→1 sweep, with the control's horizon
>   and verticals held throughout. This is exactly what the fade feature wants.
> - **Z-Image (HD): a step, not a ramp.** w=0.0–0.4 is essentially one image, it snaps
>   between 0.5 and 0.6, and 0.6–1.0 is essentially another. Linear weight does not give
>   linear perceptual change. A fade on HD therefore reads as a *soft cut placed partway
>   through the fade window* rather than as a dissolve.
>
> Sheets: `data/dream_probe/lerp-{draft,hd}-seed1.png`. See *The HD fade is a step* below.

**Goal:** `imagegen.dream_frames(...)` — hand it control frames and a per-frame plan, get
back generated frames. Backend only; no card, no route, no schedule logic. This step is
where the two genuinely unknown things live (the txt2img ControlNet pipe on the draft
model, and whether Z-Image's embeddings lerp), so it goes first and alone.

**Prerequisites:** none beyond what AI Stylize already ships.

## The entry point

```python
def dream_frames(control, plan, *, model=None, short=None,
                 on_progress=None, should_cancel=None) -> np.ndarray
```

- `control`: `[T,h,w,3]` uint8 — the control images, one per frame, already rendered.
- `plan`: length-`T` list of per-frame dicts, `{prompt_a, prompt_b, w, seed, scale}`. Step
  03 builds it; step 01 only consumes it. Keeping the plan as *data* is what lets this
  function be tested against a fake pipe with no schedule code in the picture.
- Returns `[T,H,W,3]` uint8 at `_work_dims(h, w, short)`, the `stylize_frames` convention.
- `short=None` resolves per model exactly as `stylize_frames` does: draft 384, HD 576 (the
  empirical floor below which Z-Image paints blobs on a sparse input). Export passes 768.
- `on_progress(done, total)` / `should_cancel()` — the `jobs.py` contract.
- Runs under the existing `imagegen._infer_lock`, so a Dream job, an AI Stylize job and an
  Image-gen ✨ can never put two pipes on MPS at once.

There is no `strength`, no `image=`, no `latents=`, no sigma truncation. Each frame is
`pipe(prompt…, control_image=…, controlnet_conditioning_scale=…, generator=…)` and
nothing else. The Z-Image path in `stylize_frames` — `_zimage_sigmas`, the noised VAE
encode, the `scale_noise` convention — is exactly the machinery Dream does **not** need,
because `ZImageControlNetPipeline` was txt2img + control all along.

## `_load_stylize_pipe` gains a txt2img mode

Today: `_load_stylize_pipe(model, inpaint: bool, control: bool)`, cache key
`f"{model}:{'inpaint' if inpaint else 'img2img'}{':ctrl' if control else ''}"`. Two modes
encoded in a bool is already at its limit; a third makes it wrong.

Replace the bool with `mode: Literal["img2img", "inpaint", "txt2img"]` and key on it
directly. One call site to update (`stylize_frames`, which passes
`"inpaint" if inpaint else "img2img"`). Then:

- `txt2img` + `zimage` → `ZImageControlNetPipeline(**base.components, controlnet=cn)`,
  the same construction the img2img path already uses. No difference at all: the pipeline
  was never img2img.
- `txt2img` + SD → `StableDiffusionControlNetPipeline`, imported alongside the existing
  `StableDiffusionControlNetImg2ImgPipeline` / `…InpaintPipeline`. Same
  `ControlNetModel.from_pretrained(STYLIZE_CONTROLNET[model])`, same
  `safety_checker=None`.
- `txt2img` with no ControlNet configured for the model is an **error**, not a fallback.
  AI Stylize can degrade to plain img2img when control is unavailable; Dream cannot —
  without control there is nothing left but a text prompt, and the card's whole contract
  is that the output follows the control. Raise the clean `RuntimeError` the job surfaces.

## The embedding lerp

`_dream_embeds(pipe, spec, prompt_a, prompt_b, w)` returns whatever the pipe's `__call__`
wants for the text side.

- **`w == 0` or `w == 1` short-circuit** to the plain `prompt=<text>` path, bypassing all
  of this. Most frames are hold frames, so most frames pay nothing for the fade feature —
  and a hold frame must be byte-identical to what the pipeline's own encode would have
  produced, which is a test, not a hope.
- **SD (`kind: "auto"`)**: `pipe.encode_prompt` gives a fixed `[1,77,d]` tensor per prompt.
  Lerp directly. This is the standard trick and it works.
- **Z-Image (`kind: "zimage"`)**: `_encode_prompt` returns *ragged* embeddings — it
  tokenizes `padding="max_length"`, runs the encoder, then trims each prompt to its true
  token count (`prompt_embeds[i][prompt_masks[i]]`,
  `diffusers/pipelines/z_image/pipeline_z_image_controlnet.py:304`). Two prompts of
  different lengths come back different-shaped and cannot be lerped.

  The workaround: tokenize both prompts ourselves to the same `max_sequence_length`, run
  `pipe.text_encoder(..., output_hidden_states=True).hidden_states[-2]` on both — now
  identically shaped `[max_len, d]` — lerp, and trim by `mask_a | mask_b`. The union mask
  matters: trimming by either prompt alone would drop tokens the other one needs. This
  duplicates a dozen lines of `_encode_prompt` rather than calling it, which is the price
  of the ragged return; note it in a comment so nobody "simplifies" it back.

## Negative prompts are inert — drop them

Both Turbo models run at `guidance_scale=0.0`, and the pipeline gates CFG on
`self._guidance_scale > 0` (line 372-373); at 0 the negative branch is skipped entirely
and `negative_prompt_embeds` is `[]`. So the `negative="blurry, low quality, watermark,
text"` that `stylize_frames` passes does **nothing** today. Dream therefore takes no
negative prompt: not in `dream_frames`, not in `DreamData`, not in the cache key.

Turning it on would mean raising `guidance_scale`, which doubles the per-frame cost and
degrades distilled Turbo models. If that trade is ever wanted it should be a deliberate
step with a card control, not an inherited dead parameter.

**Deliberately not done:** removing the dead `negative` from `stylize_frames`. It is
inert there too, but AI Stylize's remote twin (`remote_client.stylize_remote`) passes it
positionally, and changing a shipped card's remote wire format to delete a no-op is a
worse trade than leaving it. Recorded here so the asymmetry between the two cards is on
purpose.

## The HD fade is a step — an open decision

The fine sweep (`--weights 0.42,0.46,0.50,0.54,0.58,0.62`,
`data/dream_probe/lerp-hd-seed1-fine.png`) shows the Z-Image transition is **continuous
and monotonic, but very steep**: essentially all of the visual change happens inside
`w ∈ [0.42, 0.62]`, and the outer 80% of the range barely moves. So a linear ramp across
a fade window spends ~80% of the window showing almost nothing and ~20% doing all the
work — which reads as a soft cut placed partway through, not a dissolve.

Because it is continuous, a **perceptual remap of `w`** fixes it: a curve flat near 0.5
spends most of the fade inside the active band.

**Resolved (with the user, 2026-07-29): a `fadeShape` control on the card, default 1
(linear).** `cut_schedule._shaped` / `cutSchedule.fadeShaped`:

```
shape == 1        ->  u                                   (identity)
otherwise         ->  0.5 + 0.5·sign(2u−1)·|2u−1|^shape
```

Above 1 flattens the midpoint, below 1 steepens it; 0, 0.5 and 1 are fixed points at every
shape, so a fade always starts at A, ends at B, and keeps the cut frame's `o/(o+i)`
meaning. On a symmetric 1-second dissolve at shape 3 the ramp frames land at w = 0.4375 /
0.5 / 0.5625 — all three inside HD's active band, where linear puts two of the three
(0.25, 0.75) in the dead zone.

A **control** rather than a per-model constant, deliberately: the band was measured on one
prompt pair and nothing says it is the same for others, so a hardcoded curve would be
right on the probe and silently wrong elsewhere. SD keeps the linear default it already
morphs well under; HD users turn the knob up.

## Risks

- **The lerp midpoint may be mud.** Z-Image's text encoder is causal (attention-masked,
  `hidden_states[-2]`), so a position-wise lerp between two different sentences is less
  principled than on SD's bidirectional CLIP. Mitigation is measurement, not code: the
  exit gate below renders a sweep and looks at it. If it fails, the fade knob degrades to
  hard cuts and the rest of the wave is unaffected — which is why this is step 01.
- **The draft ControlNet at txt2img.** `thepowefuldeez/sd21-controlnet-canny` has only
  ever been exercised here through the img2img pipeline. At txt2img with no image anchor,
  a sparse canny map may not constrain enough to produce a subject. If so, the draft model
  is the casualty, not the card — HD still works, and the editor falls back to generating
  at draft *size* on the HD model.
- **Cost.** One diffusion call per frame, unchanged from AI Stylize. Nothing in this step
  makes it worse; step 02 is what makes it survivable.

## Exit gate

A script under `scripts/` (the `ai_stylize_prototype.py` precedent) that takes a short
control clip and two prompts, generates: (a) a hold sweep at `w=0` and `w=1`, asserting
byte-identity with the plain-prompt path; (b) a lerp sweep at `w = 0.1 … 0.9` on both
models, written out as a contact sheet. A human looks at the sheet and says whether the
midpoints are images or mud. That verdict goes into this file as a status note.

## Verification

- pytest: `dream_frames` against a fake pipe — plan length drives call count, `w∈{0,1}`
  takes the plain-prompt path, seeds reach the generator, `control_scale` reaches the
  kwarg, `should_cancel` stops mid-run, `on_progress` counts to `T`; `_load_stylize_pipe`
  keys the three modes distinctly and raises on txt2img without a ControlNet; the
  union-mask trim keeps `len(mask_a | mask_b)` tokens.
- `make lint`. No frontend surface in this step.
