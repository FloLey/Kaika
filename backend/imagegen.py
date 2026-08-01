"""Local text-to-image generation for the Image gen card's ✨ generate.

Two models, picked per call (the card's dropdown / the export's HD pass):

- **draft** `stabilityai/sd-turbo` (~2 GB, 2 steps) — near-instant on MPS, used
  while building so the on-canvas preview stays fast.
- **HD** `Tongyi-MAI/Z-Image-Turbo` (a ~6B DiT, ~33 GB, 8 steps) — minutes per
  image on MPS, used for the fresh regeneration at final export.

Everything is LAZY and per-model cached: diffusers imports + each pipeline load
happen on first use of that model, so the app boots (and runs) without the
packages or either model — generation just raises a clean message the job
surfaces on the card (the `llm.py` raise-and-fallback shape).

Sizing follows the project's aspect: `generate` takes the output `aspect`
(w, h) and a `long_edge`, and produces an image scaled to that aspect with its
longest side at `long_edge` (rounded to a multiple of 16, capped at the model's
native max). Draft calls pass a small `long_edge`; the export HD pass passes the
size chosen at render time.

Determinism: generation is seeded (`torch.Generator`), so the same
prompt/seed/size/model reproduces the same image — and results are stored as
content-addressed assets anyway, so re-generation never mutates an existing URL
(which would silently defeat the render cache).
"""

from __future__ import annotations

import logging
import os
import threading

# HF's Xet storage backend (cas-bridge.xethub.hf.co) can stall indefinitely on some
# networks when fetching large weights (e.g. the Z-Image ControlNet Union, 6.7 GB) —
# the classic HTTPS resolve path downloads fine. Default it off so a first-time model
# fetch never hangs; a user can re-enable Xet by setting HF_HUB_DISABLE_XET=0.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

from . import settings as app_settings  # noqa: E402 — stdlib-only module, safe anywhere
from . import dream_cache  # noqa: E402 — numpy-only, no diffusers import at module scope

from .optional_deps import require_cv2

log = logging.getLogger("kaika.imagegen")

# The two known models. `kind` selects the diffusers pipeline class; `steps` is the
# model's distilled step count; `max_edge` is its native resolution ceiling.
DRAFT_MODEL = "stabilityai/sd-turbo"
HD_MODEL = "Tongyi-MAI/Z-Image-Turbo"
MODELS: dict[str, dict] = {
    HD_MODEL: {"label": "Z-Image-Turbo (HD)", "kind": "zimage", "steps": 8, "max_edge": 1024},
    DRAFT_MODEL: {"label": "SD-Turbo (fast draft)", "kind": "auto", "steps": 2, "max_edge": 768},
}
# Back-compat env override for the *default* model when a caller passes none.
DEFAULT_MODEL = os.environ.get("IMAGEGEN_MODEL", HD_MODEL)


def _pick_device() -> str:
    """cuda > mps > cpu. cuda matters for `backend/remote_app.py`, which runs THIS
    module unchanged on a rented GPU box."""
    import torch

    if torch.cuda.is_available():
        return "cuda"
    return "mps" if torch.backends.mps.is_available() else "cpu"


# The long edge (px) for the fast in-editor draft previews.
DRAFT_EDGE = int(os.environ.get("IMAGEGEN_DRAFT_EDGE", "512"))

_lock = threading.Lock()
_pipes: dict[str, object] = {}  # lazy per-model singletons — loading takes GBs + time
# One inference at a time: diffusers pipes aren't thread-safe and there is ONE GPU —
# without this, a draft ✨ on the single-worker jobs pool and an HD export regen on
# the render pool can run two pipes at once on MPS (OOM with Z-Image's ~33 GB).
_infer_lock = threading.Lock()


def _spec(model: str) -> dict:
    spec = MODELS.get(model)
    if spec is None:
        raise RuntimeError(f"unknown image model '{model}' (known: {', '.join(MODELS)})")
    return spec


def _load_pipe(model: str):
    """Import diffusers + load `model`'s pipeline on first use (cached per model).
    Raises a clean RuntimeError when the stack isn't installed or the model can't
    load — the caller (a background job) surfaces the message on the card."""
    with _lock:
        if model in _pipes:
            return _pipes[model]
        spec = _spec(model)
        try:
            import torch
            from diffusers import AutoPipelineForText2Image, ZImagePipeline
        except ImportError as e:
            raise RuntimeError(
                "image generation needs the diffusers stack — "
                "`pip install -r requirements.txt` (diffusers/transformers/safetensors)"
            ) from e
        device = _pick_device()
        try:
            if spec["kind"] == "zimage":
                # Z-Image ships fp32; bfloat16 halves the resident footprint and is its
                # recommended runtime dtype. low_cpu_mem_usage=False: load weights
                # directly (not via accelerate's meta-device path) — avoids MPS
                # meta-tensor issues that ZImagePipeline hits otherwise.
                pipe = ZImagePipeline.from_pretrained(
                    model, torch_dtype=torch.bfloat16, low_cpu_mem_usage=False
                )
            else:
                dtype = torch.float16 if device != "cpu" else torch.float32
                pipe = AutoPipelineForText2Image.from_pretrained(model, torch_dtype=dtype)
        except Exception as e:  # noqa: BLE001 — network/model errors get one clean message
            raise RuntimeError(f"could not load image model '{model}': {e}") from e
        pipe = pipe.to(device)
        log.info("imagegen: loaded %s on %s", model, device)
        _pipes[model] = pipe
        return pipe


def _target_size(long_edge: int, aspect: tuple | None, max_edge: int) -> tuple[int, int]:
    """(width, height) at the project's aspect, longest side = min(long_edge, max_edge),
    each rounded to a multiple of 16 and floored at 256. A missing/degenerate aspect
    falls back to a square."""
    edge = max(256, min(int(long_edge or max_edge), max_edge))
    aw, ah = aspect or (1, 1)
    aw, ah = float(aw or 1), float(ah or 1)
    if aw <= 0 or ah <= 0:
        aw = ah = 1.0
    if aw >= ah:  # landscape (or square): width is the long edge
        w, h = edge, edge * ah / aw
    else:  # portrait: height is the long edge
        w, h = edge * aw / ah, edge
    round16 = lambda v: max(256, int(round(v / 16)) * 16)  # noqa: E731
    return round16(w), round16(h)


def generate(
    prompt: str,
    seed: int = 1,
    count: int = 1,
    model: str | None = None,
    long_edge: int | None = None,
    aspect: tuple | None = None,
) -> list:
    """`count` PIL images for `prompt`, seeded from `seed` (image i uses seed+i so a
    batch is distinct but reproducible), rendered by `model` at the project `aspect`
    with its longest side ~`long_edge`."""
    import torch  # torch is a hard app dependency (demucs) — safe to import here

    model = model or DEFAULT_MODEL
    spec = _spec(model)
    # Remote inference (⚙ settings): ship the resolved params to the rented GPU, which
    # runs this same function there and returns the images.
    ep = app_settings.remote_endpoint("imagegen")
    if ep is not None:
        from . import remote_client

        return remote_client.generate_remote(prompt, seed, count, model, long_edge, aspect, *ep)
    pipe = _load_pipe(model)
    width, height = _target_size(long_edge or spec["max_edge"], aspect, spec["max_edge"])
    out = []
    for i in range(max(1, int(count))):
        gen = torch.Generator(device="cpu").manual_seed(int(seed) + i)
        with _infer_lock:  # serialize per image so a cancel between images can land
            result = pipe(
                prompt=str(prompt),
                num_inference_steps=spec["steps"],
                guidance_scale=0.0,  # both models are distilled guidance-free
                width=width,
                height=height,
                generator=gen,
            )
        out.append(result.images[0])
    return out


# --------------------------------------------------------------------------- #
# AI Stylize card: per-frame img2img (optionally inpaint) of a fluid clip
# --------------------------------------------------------------------------- #
# Separate pipeline singletons keyed by "<model>:img2img" / "<model>:inpaint" so
# they never collide with the text2image singleton on the same repo. Both reuse
# the exact lazy-load + MPS + _infer_lock discipline of `generate()` above.
# ControlNet checkpoints for the stylize card's `control` input, per base model. SD-Turbo
# is SD-2.1-based → an SD-2.1 ControlNet (img2img + control). Z-Image uses its ControlNet
# Union (a diffusers-format repo, ~6.7 GB) — but that pipeline is txt2img + control (no
# img2img/strength): the control image drives the whole generation. See stylize_frames.
STYLIZE_CONTROLNET: dict[str, str] = {
    DRAFT_MODEL: os.environ.get("STYLIZE_CONTROLNET", "thepowefuldeez/sd21-controlnet-canny"),
    HD_MODEL: os.environ.get(
        "STYLIZE_ZIMAGE_CONTROLNET", "hlky/Z-Image-Turbo-Fun-Controlnet-Union-2.1"
    ),
}


def _stylize_pipe_key(model: str, mode: str, control: bool) -> str:
    """Singleton key for `_load_stylize_pipe`. Z-Image + control is the special case: its
    Union pipeline is txt2img+control whatever the caller asks for (AI Stylize hand-rolls
    img2img on top of it, see stylize_frames), so all three modes must land on ONE
    instance — keying them apart would load 6.7 GB of Union weights twice."""
    if control and _spec(model)["kind"] == "zimage":
        return f"{model}:zctrl"
    return f"{model}:{mode}{':ctrl' if control else ''}"


def _load_stylize_pipe(model: str, mode: str, control: bool):
    """A stylize/dream pipeline singleton. `mode` is "img2img" | "inpaint" | "txt2img" —
    a bool stopped being enough when the Dream card needed a third one."""
    inpaint = mode == "inpaint"
    key = _stylize_pipe_key(model, mode, control)
    with _lock:
        if key in _pipes:
            return _pipes[key]
        spec = _spec(model)
        try:
            import torch
            from diffusers import AutoPipelineForImage2Image, AutoPipelineForInpainting
        except ImportError as e:
            raise RuntimeError(
                "image generation needs the diffusers stack — "
                "`pip install -r requirements.txt` (diffusers/transformers/safetensors)"
            ) from e
        device = _pick_device()
        dtype = (
            torch.bfloat16
            if spec["kind"] == "zimage"
            else (torch.float16 if device != "cpu" else torch.float32)
        )
        try:
            if mode == "txt2img" and not control:
                # Only the Dream card asks for txt2img here, and it always has a control
                # map — without one there is nothing to follow but the prompt, which is
                # `generate()`'s job, not this one. Refuse rather than silently duplicate.
                raise RuntimeError("txt2img stylize pipe needs a control input")
            if control:
                cn_repo = STYLIZE_CONTROLNET.get(model)
                if cn_repo is None:
                    raise RuntimeError(f"no ControlNet configured for model '{model}'")
                if spec["kind"] == "zimage":
                    # Z-Image ControlNet Union: a txt2img + control pipeline (no img2img /
                    # strength / mask) — the control image alone drives the generation, so
                    # `inpaint` is not applicable here. Build it from the base Z-Image
                    # components + the Union weights.
                    from diffusers import (
                        ZImageControlNetModel,
                        ZImageControlNetPipeline,
                        ZImagePipeline,
                    )

                    cn = ZImageControlNetModel.from_pretrained(cn_repo, torch_dtype=dtype)
                    base = ZImagePipeline.from_pretrained(
                        model, torch_dtype=dtype, low_cpu_mem_usage=False
                    )
                    pipe = ZImageControlNetPipeline(**base.components, controlnet=cn)
                else:
                    from diffusers import (
                        ControlNetModel,
                        StableDiffusionControlNetImg2ImgPipeline,
                        StableDiffusionControlNetInpaintPipeline,
                        StableDiffusionControlNetPipeline,
                    )

                    cn = ControlNetModel.from_pretrained(cn_repo, torch_dtype=dtype)
                    cls = {
                        "inpaint": StableDiffusionControlNetInpaintPipeline,
                        "img2img": StableDiffusionControlNetImg2ImgPipeline,
                        # txt2img: the Dream card — no init image, the control map alone
                        # decides the shapes. Note this pipeline names the control image
                        # `image` (the img2img one keeps `image` for the init frame and
                        # takes `control_image` instead).
                        "txt2img": StableDiffusionControlNetPipeline,
                    }[mode]
                    pipe = cls.from_pretrained(
                        model, controlnet=cn, torch_dtype=dtype, safety_checker=None
                    )
            elif spec["kind"] == "zimage":
                from diffusers import ZImageImg2ImgPipeline, ZImageInpaintPipeline

                cls = ZImageInpaintPipeline if inpaint else ZImageImg2ImgPipeline
                pipe = cls.from_pretrained(model, torch_dtype=dtype, low_cpu_mem_usage=False)
            else:
                cls = AutoPipelineForInpainting if inpaint else AutoPipelineForImage2Image
                pipe = cls.from_pretrained(model, torch_dtype=dtype, safety_checker=None)
        except RuntimeError:
            raise
        except Exception as e:  # noqa: BLE001 — one clean message the job surfaces
            raise RuntimeError(f"could not load stylize model '{model}': {e}") from e
        pipe = pipe.to(device)
        pipe.set_progress_bar_config(disable=True)
        log.info("imagegen: loaded stylize pipe %s on %s", key, device)
        _pipes[key] = pipe
        return pipe


def _work_dims(gh: int, gw: int, short: int) -> tuple[int, int]:
    """(H, W) at the grid aspect, short side ≈ `short`, each a multiple of 16."""
    if gw <= gh:
        w, h = short, round(short * gh / gw)
    else:
        h, w = short, round(short * gw / gh)
    r16 = lambda v: max(256, int(round(v / 16)) * 16)  # noqa: E731
    return r16(h), r16(w)


def _zimage_sigmas(full: list[float], strength: float) -> list[float]:
    """Truncate Z-Image's sigma schedule so denoising starts partway — i.e. img2img.

    `full` is the model's schedule (sigma 1.0 = pure noise → small sigma = clean image).
    Dropping its first `1 - strength` fraction starts from a partly-noised copy of the input
    instead of pure noise. We NEVER keep sigma 1.0 (`max(1, ...)`): a ControlNet *guides*
    structure but does not *confine* generation, so without an img2img anchor the model just
    fills the frame and ignores a sparse control. Hence HD+control always tracks its input.
    """
    if len(full) < 2:  # nothing to drop — can't anchor a single-step schedule
        return list(full)
    start = max(1, min(int(len(full) * (1.0 - strength)), len(full) - 1))
    return list(full[start:])


def _zimage_img2img(pipe, spec: dict, img, strength: float, gen, H: int, W: int, mask=None) -> dict:
    """Hand-roll img2img onto Z-Image's ControlNet pipeline, which ships as txt2img+control.

    Returns the `latents`/`sigmas`/`num_inference_steps` kwargs that start the denoise
    partway, from a noised encode of `img`, instead of from pure noise. Shared by
    AI Stylize (where it is the whole point) and the Dream card (where it is what an
    optional wired `video` input turns on).

    A ControlNet *guides* structure but does not *confine* generation, so without this
    anchor the model fills the frame and ignores a sparse control — which is exactly why
    Dream's default (no anchor at all) reinvents its background, and why wiring a video
    brings the input's layout back."""
    import torch
    from PIL import Image
    from diffusers.pipelines.z_image.pipeline_z_image_controlnet import (  # lazy, like the rest
        get_default_z_image_sigmas,
        retrieve_latents,
    )

    device = pipe._execution_device
    sub = _zimage_sigmas(get_default_z_image_sigmas(int(spec["steps"])), strength)
    # The scheduler REMAPS requested sigmas (shift=3.0: 0.875 → 0.955). Noise with the
    # sigma it will actually use — noising with the raw one under-noises the latents, so
    # the model "denoises" absent noise and just reconstructs the input.
    pipe.scheduler.set_timesteps(sigmas=sub, device=device)
    sigma0 = float(pipe.scheduler.sigmas[0])
    px = pipe.image_processor.preprocess(Image.fromarray(img), height=H, width=W)
    z0 = retrieve_latents(
        pipe.vae.encode(px.to(device, dtype=pipe.vae.dtype)),
        generator=gen,
        sample_mode="argmax",
    )
    z0 = (z0 - pipe.vae.config.shift_factor) * pipe.vae.config.scaling_factor
    noise = torch.randn(z0.shape, generator=gen, dtype=torch.float32).to(device, dtype=z0.dtype)
    latents = sigma0 * noise + (1.0 - sigma0) * z0  # the scheduler's scale_noise convention
    return {
        "latents": latents.to(pipe.transformer.dtype),
        "sigmas": sub,
        "num_inference_steps": len(sub),
    }


# Floor under a dark control's mean luminance: a nearly-black control fades coverage out
# rather than being normalised up to full — black must still mean "invent".
_KEEP_FLOOR = 0.05
# Gaussian sigma (in latent cells) that spreads a sparse control's support so `keep`
# is not capped at the control's own white fraction. See `_keep_mask`.
_KEEP_SPREAD = 2.0
# Real denoise steps the re-injection needs: at least two landing at a sigma where the
# source is legible, plus two free ones to harmonise the mosaic. Below this the un-kept
# cells resolve to grey mush instead of invention.
_DREAM_SEEDED_STEPS = 6
# Fraction of the schedule over which kept cells are pinned. The free tail is what lets
# the model blend the scatter into a picture and lets the prompt and ControlNet act
# everywhere; pinning to the last step freezes the exact source latent in those cells and
# the result reads as an 8-pixel dither rather than a generated image.
_INJECT_FRAC = 0.6


def _keep_mask(control_img, keep: float, seed: int, lh: int, lw: int):
    """The Dream card's scatter: a 0..1 weight per LATENT cell = the chance that cell
    keeps the source image.

    Per LATENT CELL, not per pixel, and that is not a shortcut. Both VAEs map an 8x8
    pixel block to one latent cell, so a per-pixel scatter is low-passed away by the
    encoder before the model ever sees it — the finest stencil that can physically
    survive is one cell. (The first version of this built the composite in PIXEL space on
    a bed of uniform RGB noise; uniform noise is nowhere near the natural-image manifold,
    so the encode produced latents the model could not interpret and the card emitted
    pure noise. Do not move this back to pixels.)

    `keep` is a TARGET MEAN COVERAGE of the frame, distributed by the control's
    brightness — not a multiplier on raw luminance. The normalisation is what makes it
    mean the same thing on a 2%-white canny map (the card's own default control) as on a
    smooth depth map: without it, `keep` 0.05 / 0.1 / 0.25 all landed on ~0.2% coverage
    and were visually identical.

    Deterministic from `seed`, so the frame cache stays valid — a random stencil would
    make every re-run a miss. The stencil is fixed in SCREEN space within a part, so the
    source moves through it while it holds still (the same rationale as the fixed
    per-frame generator seed).
    """
    import numpy as np

    cv2 = require_cv2("the Dream card")

    k = float(np.clip(keep, 0.0, 1.0))
    if k <= 0:
        return np.zeros((lh, lw), np.float32)
    g = cv2.cvtColor(np.ascontiguousarray(control_img), cv2.COLOR_RGB2GRAY)
    # INTER_AREA, never INTER_LINEAR: a latent cell sees the MEAN of its 8x8 block, and
    # that mean is the only thing the VAE can carry of a finer field.
    lum = cv2.resize(g, (lw, lh), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
    # Spread the support before normalising. The card's DEFAULT control is an auto-canny
    # — a couple of percent white — whose cells clip to p=1 immediately, so `keep`
    # saturated at the map's own coverage (~6%) and the top of the slider did nothing.
    # Blurring lets the seeding bleed outward from the contours as `keep` rises, which is
    # both usable across the whole range and the right look: near the structure, not on
    # it exactly. Harmless on an already-smooth control (a depth or density map).
    lum = cv2.GaussianBlur(lum, (0, 0), _KEEP_SPREAD)
    p = np.clip(lum * (k / max(float(lum.mean()), _KEEP_FLOOR)), 0.0, 1.0)
    u = np.random.default_rng(int(seed)).random(p.shape, dtype=np.float32)
    # A hard threshold, not a soft ramp: E[m] is then EXACTLY p, so `keep` really is the
    # coverage it claims to be, and p == 0 gives exactly 0 (a black control must seed
    # nothing). A ramp biased the mean down by half its width and, once re-centred, gave
    # a black control a few percent of coverage — both wrong in ways a slider hides.
    # Modulation stays smooth anyway because `u` is fixed per seed: raising `keep` only
    # ever ADDS cells, never swaps them.
    return (u < p).astype(np.float32)


def _seeded_injection(pipe, iimg, mask, gen, H: int, W: int, nsteps: int, flow: bool) -> dict:
    """The kwargs that make a Dream generation grow out of a scatter of the source.

    Encodes the source once, then hands back a `callback_on_step_end` that pins the
    stencilled latent cells onto its noised trajectory after every step. The generation
    itself starts from the pipeline's own noise — a free txt2img — so the un-stencilled
    region is genuinely invented rather than denoised from a doctored start."""
    import torch
    from PIL import Image

    device = pipe._execution_device
    px = pipe.image_processor.preprocess(Image.fromarray(iimg), height=H, width=W)
    if flow:
        from diffusers.pipelines.z_image.pipeline_z_image_controlnet import retrieve_latents
    else:
        from diffusers.pipelines.stable_diffusion.pipeline_stable_diffusion_img2img import (
            retrieve_latents,
        )
    z0 = retrieve_latents(
        pipe.vae.encode(px.to(device, dtype=pipe.vae.dtype)),
        generator=gen,
        # mode(), not sample(): deterministic AND consumes no RNG, so the frame cache
        # stays byte-stable across re-runs.
        sample_mode="argmax",
    )
    cfg = pipe.vae.config
    # Flux-family VAEs (Z-Image) shift before scaling; SD's does not carry the field.
    shift = getattr(cfg, "shift_factor", None) or 0.0
    z0 = (z0 - shift) * cfg.scaling_factor
    m = torch.from_numpy(mask).to(device, dtype=z0.dtype)[None, None]  # broadcast over C
    noise = torch.randn(z0.shape, generator=gen, dtype=torch.float32).to(device, dtype=z0.dtype)
    return {
        "callback_on_step_end": _inject_cb(z0, noise, m, nsteps, flow=flow),
        "callback_on_step_end_tensor_inputs": ["latents"],
    }


def _inject_cb(z0, noise, m, nsteps: int, *, flow: bool):
    """A `callback_on_step_end` that pins the kept cells back onto the source's noised
    trajectory after each scheduler step.

    A blended START latent alone is not enough, and this is the part that makes `keep`
    work at all: at a high sigma the kept cells are drowned (nothing shows), and at a low
    one the un-kept cells are not free — they are a valid sample of "x0 = 0 + noise", so a
    distilled model resolves them to grey. Re-injecting at each new sigma pins the source
    where the stencil is while leaving the rest a genuine free generation, and the model's
    receptive field grows the invented content OUT of the scattered seeds.
    """
    n_inject = max(1, int(round(nsteps * _INJECT_FRAC)))

    def cb(pipe, i, t, kw):
        if i >= n_inject:
            return {}
        lat = kw["latents"]
        # After scheduler.step the step index has advanced, so this is the sigma the
        # running latents now live at. Reading it from the scheduler (rather than
        # indexing the timestep loop) stays correct when `strength` < 1 slices the
        # timesteps but not the sigmas array.
        s = pipe.scheduler.sigmas[pipe.scheduler.step_index].to(lat.dtype)
        tgt = (s * noise + (1.0 - s) * z0) if flow else (z0 + noise * s)
        return {"latents": (m * tgt + (1.0 - m) * lat).to(lat.dtype)}

    return cb


def _density_mask(dye):
    """Soft 0..1 mask of where the clip has substance (its luminance) — confines a repaint
    to the fluid's shape so its black background survives untouched."""
    import numpy as np

    cv2 = require_cv2("the AI Stylize card")

    g = cv2.cvtColor(dye, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
    return np.clip(cv2.GaussianBlur(g, (0, 0), 3) * 3, 0, 1)


def stylize_frames(
    frames,
    prompt: str,
    strength: float = 0.8,
    inpaint: bool = False,
    model: str | None = None,
    seed: int = 1,
    control=None,
    control_scale: float | None = None,
    negative: str = "blurry, low quality, watermark, text",
    on_progress=None,
    short: int | None = None,
):
    """Stylize a clip `frames` ([T,h,w,3] uint8) → [T,H,W,3] uint8.

    Per-frame img2img from the input (so position + luminosity are kept), with `strength` as
    the denoise fraction. `control` (optional [T,h,w,3] control images from an Extract card)
    drives a ControlNet so the result also follows the input's structure — note a ControlNet
    *guides* shape but never *confines* generation, so the img2img start is what keeps the
    fluid's black background black. `inpaint` confines the repaint to the input's density.
    The SAME fixed seed each frame → coherence."""
    import numpy as np
    import torch

    cv2 = require_cv2("the AI Stylize card")
    from PIL import Image

    model = model or DRAFT_MODEL
    spec = _spec(model)
    # Per-model control influence: 0.65 is the Union's sweet spot (alibaba-pai's own examples);
    # stronger flattens texture — petals become a uniform glow. The SD ControlNet takes 0.8.
    if control_scale is None:
        control_scale = 0.65 if spec["kind"] == "zimage" else 0.8
    # Default (preview) short side, per model. Draft: 384 — fast iteration, SD-Turbo stays
    # coherent there. Z-Image: 576 — the empirical QUALITY FLOOR for the 6B DiT (trained at
    # ~1024+): at 384/448/512 it paints blobs instead of subjects on a sparse input (measured
    # on the playground fluid). The export passes a larger `short` (768).
    if short is None:
        short = 576 if spec["kind"] == "zimage" else 384
    have_control = control is not None and len(control) > 0
    # Remote inference (⚙ settings): once every default is resolved, the whole call can run
    # verbatim on the rented GPU — the server invokes THIS function there with explicit params.
    ep = app_settings.remote_endpoint("stylize")
    if ep is not None:
        from . import remote_client

        return remote_client.stylize_remote(
            frames,
            prompt,
            strength,
            inpaint,
            model,
            seed,
            control if have_control else None,
            control_scale,
            negative,
            int(short),
            *ep,
            on_progress=on_progress,
        )
    # Follow the input by default (draft only): with no explicit control wired, use canny of
    # the input as a ControlNet so the output tracks the input's shapes. HD (Z-Image) keeps
    # its progressive img2img `strength` by default and only uses the Union when control is
    # explicitly wired (its ControlNet pipeline is txt2img-only — no img2img base).
    auto_control = not have_control and model == DRAFT_MODEL
    use_control = have_control or auto_control
    # A model with no ControlNet configured can't use control: fall back to plain img2img
    # instead of erroring (its `strength` still tracks the input's structure).
    if use_control and model not in STYLIZE_CONTROLNET:
        if have_control:
            log.warning(
                "control not available for '%s' (no ControlNet) — generating without it", model
            )
        use_control = False
    pipe = _load_stylize_pipe(model, "inpaint" if inpaint else "img2img", use_control)
    # Z-Image's ControlNet pipeline ships as txt2img + control (no image/strength/mask args),
    # so `_zimage_img2img` hand-rolls the anchor onto it. Draft's ControlNet pipeline is
    # img2img natively.
    zimage_control = use_control and spec["kind"] == "zimage"
    gh, gw = int(frames.shape[1]), int(frames.shape[2])
    H, W = _work_dims(gh, gw, int(short))
    strength = float(np.clip(strength, 0.05, 1.0))
    # diffusers img2img runs int(steps*strength) real steps — pick steps so that's ≥1
    # AND at least the model's distilled count.
    import math

    steps = max(int(spec["steps"]), math.ceil(1.5 / strength))
    out = np.empty((len(frames), H, W, 3), np.uint8)
    for i in range(len(frames)):
        dye = cv2.resize(np.ascontiguousarray(frames[i]), (W, H), interpolation=cv2.INTER_LINEAR)
        gen = torch.Generator(device="cpu").manual_seed(int(seed))  # fixed → coherent
        cimg = None
        if use_control:
            if have_control:
                c = control[min(i, len(control) - 1)]
                cimg = cv2.resize(np.ascontiguousarray(c), (W, H), interpolation=cv2.INTER_LINEAR)
            else:  # auto (draft): canny of the (resized) input so the output follows its shapes
                cimg = cv2.cvtColor(
                    cv2.Canny(cv2.cvtColor(dye, cv2.COLOR_RGB2GRAY), 80, 160), cv2.COLOR_GRAY2RGB
                )
        if zimage_control:
            # The Union's pipeline is txt2img + control, so we hand-roll img2img: seed its
            # `latents` with a noised encode of the input and hand it the matching tail of the
            # sigma schedule. Without that anchor the model ignores a sparse control entirely.
            kw = dict(
                prompt=str(prompt),
                negative_prompt=negative,
                height=H,
                width=W,
                guidance_scale=0.0,
                generator=gen,
                control_image=Image.fromarray(cimg),
                controlnet_conditioning_scale=float(control_scale),
                **_zimage_img2img(pipe, spec, dye, strength, gen, H, W),
            )
        else:
            kw = dict(
                prompt=str(prompt),
                negative_prompt=negative,
                image=Image.fromarray(dye),
                strength=strength,
                num_inference_steps=steps,
                guidance_scale=0.0,
                generator=gen,
            )
            if inpaint:
                kw["mask_image"] = Image.fromarray((_density_mask(dye) * 255).astype(np.uint8))
            if use_control:
                kw["control_image"] = Image.fromarray(cimg)
                kw["controlnet_conditioning_scale"] = float(control_scale)
        with _infer_lock:  # one inference at a time on the single GPU
            res = pipe(**kw)
        img = np.asarray(res.images[0])
        if img.shape[:2] != (H, W):  # never crash if the pipe ignores the aspect
            img = cv2.resize(img, (W, H), interpolation=cv2.INTER_LINEAR)
        if inpaint and zimage_control:
            # The Union's pipeline takes no mask, so confine the repaint afterwards with the same
            # density mask the SD inpaint path feeds its pipe: outside it, keep the input as-is.
            m = _density_mask(dye)[..., None]
            img = (img.astype(np.float32) * m + dye.astype(np.float32) * (1.0 - m)).astype(np.uint8)
        out[i] = img
        if on_progress is not None:
            on_progress(i + 1, len(frames))
    return out


# --------------------------------------------------------------------------- #
# Dream card: pure txt2img + ControlNet on a prompt schedule (specs/dream/)
# --------------------------------------------------------------------------- #
# The distinction from stylize_frames above is the whole card: there is NO img2img
# anchor. stylize_frames keeps the input's position and luminosity by starting from a
# noised copy of it — even on Z-Image, where it hand-rolls that anchor onto a pipeline
# that was txt2img all along (`_zimage_sigmas`, the seeded latents). Dream starts from
# pure noise every frame, so consecutive frames share nothing but the control map, and
# the imagery is free to reinvent itself. That freedom is the point, not a side effect.

# Z-Image's `_encode_prompt` default (`max_sequence_length`). We re-tokenize with the
# same value so a lerp's endpoints line up with the pipeline's own encode; if diffusers
# ever changes its default, the parity test in test_dream.py is what catches it.
_ZIMAGE_MAX_TOKENS = 512


# Below this much VRAM the text encoder's ~4 GB is the difference between running and
# not: measured on a 24 GB 4090, the HD pipeline resident allocated 22.8 GiB and the next
# 76 MiB request was the one that raised. 32 GB is the first common size with headroom.
_RELEASE_ENCODER_UNDER_GB = 32


def _encode_one(pipe, spec: dict, text: str, run_on, keep_on) -> tuple:
    """`(hidden_states, mask)` for ONE prompt — the raw material both frame paths need.

    Z-Image's own `_encode_prompt` TRIMS to the true token count
    (`prompt_embeds[i][prompt_masks[i]]`), so two prompts of different lengths come back
    different-SHAPED and cannot be lerped element-wise. Keep the PADDED states here,
    identically `[max_tokens, d]` whatever the prompt, and let the caller trim: by this
    prompt's own mask for a hold, by the UNION of two for a blend.

    SD's CLIP already pads to a fixed 77, so there is nothing to undo — `mask` is None
    and the caller passes the tensor through.

    `run_on` is where the encoder itself lives, `keep_on` where the result is wanted.
    They differ on a card too small to hold the encoder: the forward runs in host RAM and
    only the (tiny) embeddings come back.
    """
    if spec["kind"] != "zimage":
        emb, _ = pipe.encode_prompt(text, run_on, 1, False)
        return emb.to(keep_on), None
    templated = pipe.tokenizer.apply_chat_template(
        [{"role": "user", "content": text}],
        tokenize=False,
        add_generation_prompt=True,
        enable_thinking=True,
    )
    ti = pipe.tokenizer(
        [templated],
        padding="max_length",
        max_length=_ZIMAGE_MAX_TOKENS,
        truncation=True,
        return_tensors="pt",
    )
    mask = ti.attention_mask.to(run_on).bool()[0]
    hs = pipe.text_encoder(
        input_ids=ti.input_ids.to(run_on),
        attention_mask=mask[None],
        output_hidden_states=True,
    ).hidden_states[-2][0]
    return hs.to(keep_on), mask.to(keep_on)


def _encoder_home(device) -> str | None:
    """Where the text encoder should live: `"cpu"` to keep it off a small card, else None
    (leave it wherever the pipeline put it).

    Deciding this BEFORE the encode, not after, is the whole point. `pipe.to(device)`
    moves every component up, and on a 24 GB card that leaves 9.75 MiB free — measured:
    the encode could not allocate its own 30 MiB workspace, so a release scheduled for
    afterwards was never reached. Off the card first, encode in host RAM, and only the
    embeddings come back.

    Only where host and device memory are separate pools. On MPS the two share one, so
    there is nowhere to move TO and this would buy nothing.

    `str()` first: `_execution_device` is a torch.device, and `torch.device("cuda")`
    compares UNEQUAL to the string "cuda", so a plain `!=` skips this on the one hardware
    it exists for — while a fake pipe holding a string makes the test agree.
    """
    if not str(device).startswith("cuda"):
        return None
    import torch

    if torch.cuda.get_device_properties(0).total_memory / 2**30 >= _RELEASE_ENCODER_UNDER_GB:
        return None
    return "cpu"


def _dream_conditioning(pipe, spec: dict, plan: list):
    """Encode every distinct prompt in `plan` ONCE, then return `embeds(step) -> kwargs`.

    The text encoder's input is the prompt TEXT — nothing per-frame. A schedule holds a
    handful of distinct prompts, so encoding inside the frame loop re-ran the same few
    strings thousands of times for an identical result, AND pinned ~4 GB of weights on the
    device for the whole render. Both go away by hoisting the encode out here.

    Prompts are collected through `dream_cache.canonical_prompts` — the same collapse the
    cache keys on, which already drops the second prompt where it cannot affect a pixel.
    Sharing it means we encode exactly what gets rendered, and the two cannot drift.

    Every frame now takes THIS path, holds included. That is deliberate and it is what
    makes the release safe: leave one frame on the pipeline's internal encode and the
    first call after the release finds the encoder on the wrong device. It is also why
    the path cannot be gated on card size — the frame cache is shared between local and
    remote runs and keys only on inputs, so a machine-dependent encode would let one clip
    mix frames from two different generations under identical keys.
    """
    import torch

    zimage = spec["kind"] == "zimage"
    device = pipe._execution_device

    wanted: list[str] = []
    for step in plan:
        a, b, w = dream_cache.canonical_prompts(step)
        for text in (a, b) if (w > 0 and b) else (a,):
            if text not in wanted:
                wanted.append(text)

    # Move it BEFORE encoding, not after: on a card the pipeline already fills, the
    # encode's own workspace is what fails. `_pipes` caches the pipeline across jobs, so
    # this also re-homes an encoder the last job left elsewhere.
    home = _encoder_home(device)
    enc = getattr(pipe, "text_encoder", None)
    if enc is not None and hasattr(enc, "to"):
        enc.to(home or device)
    if home is not None:
        import torch as _t

        _t.cuda.empty_cache()  # hand the ~4 GB back before anything asks for workspace
        log.info("imagegen: text encoder kept in host RAM — %s prompt(s) to encode", len(wanted))
    encoded = {text: _encode_one(pipe, spec, text, home or device, device) for text in wanted}

    def embeds(step: dict) -> dict:
        a, b, w = dream_cache.canonical_prompts(step)
        hs_a, mask_a = encoded[a]
        if w <= 0 or not b:
            return {"prompt_embeds": [hs_a[mask_a]] if zimage else hs_a}
        hs_b, mask_b = encoded[b]
        mixed = torch.lerp(hs_a.float(), hs_b.float(), float(w)).to(hs_a.dtype)
        # Positions valid in only ONE prompt lerp against the other's masked-padding
        # state, so a token the shorter prompt lacks fades out rather than snapping.
        return {"prompt_embeds": [mixed[mask_a | mask_b]] if zimage else mixed}

    return embeds


class Cancelled(RuntimeError):
    """A generation stopped because its caller asked it to.

    An exception rather than a partial return: a Dream run is one diffusion call per
    frame, so "stop" has to be heard INSIDE the loop, and a half-filled array that looks
    like a result is exactly the thing a caller forgets to check. Callers that can be
    cancelled catch this and treat it as "nothing happened".
    """


def dream_frames(
    control, plan, *, init=None, model=None, short=None, on_progress=None, should_cancel=None
):
    """Generate one image per `plan` entry, each guided by `control[i]` — [T,H,W,3] uint8.

    `control` is [T,h,w,3] uint8 (an Extract card's edges/depth, or any control map).
    `plan` is one dict per frame, `{prompt_a, prompt_b, w, seed, scale, strength}`, built by
    `cut_schedule.dream_plan`. Keeping the schedule OUT of this function is deliberate:
    it makes the generator testable against a fake pipe with no scheduling in the picture,
    and it means the cache (dream_cache) can key on exactly what the pipe is handed.

    `should_cancel` is polled once per GENERATED frame (not per cached one — a warm pass
    is milliseconds) and raises `Cancelled` when it returns true. Checking only between
    whole calls is not enough and the gap is not theoretical: an HD export cancelled by
    the user kept diffusing a 617-frame node for another 25 minutes, because the only
    cancellation test in the export's Dream pass sat BETWEEN cards.

    `init` is the OPTIONAL per-frame start image (the card's wired `video` input). Without
    it every frame starts from pure noise and only the control ties one frame to the next
    — the card's default, and why its background is invented rather than preserved. With
    it each frame starts from `init[i]` at that frame's `strength`, so the source's layout
    and its black background survive; the schedule, fades, seeds and cache are unchanged.

    Exactly one of `control` / `init` may be None. With `init` but no `control`, the
    control is a CANNY of the init frame, so a single wired video is enough to make the
    card work (the same auto-control AI Stylize applies on its draft model)."""
    import numpy as np
    import torch

    cv2 = require_cv2("the Dream card")
    from PIL import Image

    model = model or DRAFT_MODEL
    spec = _spec(model)
    if model not in STYLIZE_CONTROLNET:
        raise RuntimeError(
            f"the Dream card needs a ControlNet for '{model}' and none is configured — "
            "without one there is nothing for the output to follow"
        )
    if not len(plan):
        raise ValueError("dream_frames: empty plan")
    have_control = control is not None and len(control) > 0
    have_init = init is not None and len(init) > 0
    if not have_control and not have_init:
        raise ValueError("dream_frames: needs a control clip, an init clip, or both")
    # Per-model preview short side, the stylize_frames split: draft 384 (fast iteration),
    # HD 576 (the empirical floor below which Z-Image paints blobs on a sparse input).
    # The export passes a larger `short`.
    if short is None:
        short = 576 if spec["kind"] == "zimage" else 384
    zimage = spec["kind"] == "zimage"
    dims_from = control if have_control else init
    gh, gw = int(dims_from.shape[1]), int(dims_from.shape[2])
    H, W = _work_dims(gh, gw, int(short))
    out = np.empty((len(plan), H, W, 3), np.uint8)
    total = len(plan)
    done = 0

    def _tick():
        if on_progress is not None:
            on_progress(done, total)

    def _at(clip, i):
        """Frame i of a clip, holding its last frame when the clip is short."""
        return cv2.resize(
            np.ascontiguousarray(clip[min(i, len(clip) - 1)]),
            (W, H),
            interpolation=cv2.INTER_LINEAR,
        )

    # Pass 1: the cache. Hits tick the progress bar (a warm run that reported nothing
    # would look hung), misses are collected so the remote path can batch them.
    misses: list[tuple] = []
    for i, step in enumerate(plan):
        iimg = _at(init, i) if have_init else None
        if have_control:
            cimg = _at(control, i)
        else:
            # No Extract wired, but a video is: follow ITS shapes. Same auto-control
            # AI Stylize applies on its draft model, and the same thresholds.
            cimg = cv2.cvtColor(
                cv2.Canny(cv2.cvtColor(iimg, cv2.COLOR_RGB2GRAY), 80, 160), cv2.COLOR_GRAY2RGB
            )
        key = dream_cache.frame_key(cimg, step, model, H, W, init_img=iimg)
        hit = dream_cache.load(key)
        if hit is not None and hit.shape == (H, W, 3):
            out[i] = hit
            done += 1
            _tick()
            continue
        misses.append((i, cimg, step, key, iimg))

    # Remote inference (⚙ settings): hand the MISSES to the rented GPU, batched. The
    # cache stays LOCAL — looked up above, filled below — so a remote run still leaves a
    # warm cache and a re-run after a small edit goes nowhere near the network. Resolved
    # defaults travel with the call so the server applies them verbatim.
    ep = app_settings.remote_endpoint("dream") if misses else None
    if ep is not None:
        # One check before handing the whole batch over — the remote call is atomic from
        # here, so this is the last moment a cancel can be honoured on this path.
        if should_cancel is not None and should_cancel():
            raise Cancelled("dream generation cancelled before the remote batch")
        from . import remote_client

        hits = done
        got = remote_client.dream_remote(
            np.stack([c for _, c, _, _, _ in misses]),
            [s for _, _, s, _, _ in misses],
            model,
            int(short),
            *ep,
            init=np.stack([m[4] for m in misses]) if have_init else None,
            on_progress=(lambda d, _t: on_progress(hits + d, total)) if on_progress else None,
        )
        for (i, _c, _s, key, _ii), img in zip(misses, got):
            out[i] = img
            dream_cache.store(key, img)
        dream_cache.evict()
        return out

    # ONE pipeline for both paths: txt2img + control. A wired `video` does NOT switch to
    # the img2img pipeline — that one rebuilds the start latent from `image` and ignores
    # any `latents` handed to it (its `prepare_latents` has no such parameter), so the
    # scatter was silently thrown away and every `keep` produced the identical picture.
    # The source now enters ONLY through the per-step injection, which both pipelines
    # support via `callback_on_step_end`.
    # Still lazy — an all-hits run reaches neither line, since both are guarded by the
    # same `misses` the loop iterates. Hoisted out of the loop so the conditioning can be
    # built once, which is the point: encoding inside it re-ran the same prompts per frame
    # and kept ~4 GB of text encoder pinned on the device for the whole render.
    pipe = _load_stylize_pipe(model, "txt2img", True) if misses else None
    embeds = _dream_conditioning(pipe, spec, [s for _, _, s, _, _ in misses]) if misses else None
    for i, cimg, step, key, iimg in misses:
        # Before the expensive call, not after: at ~80 s/frame on MPS, a check placed one
        # line lower costs a whole frame of latency on every cancel.
        if should_cancel is not None and should_cancel():
            raise Cancelled(f"dream generation cancelled at frame {i}")
        gen = torch.Generator(device="cpu").manual_seed(int(step["seed"]))
        kw = dict(
            height=H,
            width=W,
            guidance_scale=0.0,  # both models are distilled; CFG off (see the note below)
            generator=gen,
            controlnet_conditioning_scale=float(step.get("scale", 0.7)),
        )
        # The two pipelines disagree about the control image's NAME: Z-Image's Union
        # takes `control_image`, SD's txt2img ControlNet takes `image`.
        kw["control_image" if zimage else "image"] = Image.fromarray(cimg)
        if have_init:
            # The scatter is a stencil over the LATENTS — see `_keep_mask` for why a
            # pixel-space start image cannot work here. More steps than the model's
            # distilled default, so the injection gets several passes before the free
            # tail blends them into a picture.
            steps = max(int(spec["steps"]), _DREAM_SEEDED_STEPS)
            mask = _keep_mask(cimg, float(step.get("keep", 0.1)), int(step["seed"]), H // 8, W // 8)
            kw["num_inference_steps"] = steps
            kw.update(_seeded_injection(pipe, iimg, mask, gen, H, W, steps, zimage))
        else:
            kw["num_inference_steps"] = int(spec["steps"])
        kw.update(embeds(step))
        # The lock covers INFERENCE only — a cache lookup above must not serialise
        # against a live AI Stylize job for nothing.
        with _infer_lock:  # one inference at a time on the single GPU
            res = pipe(**kw)
        img = np.asarray(res.images[0])
        if img.shape[:2] != (H, W):  # never crash if the pipe ignores the aspect
            img = cv2.resize(img, (W, H), interpolation=cv2.INTER_LINEAR)
        out[i] = img
        dream_cache.store(key, img)
        done += 1
        _tick()
    # Once per job, not once per frame: globbing the cache dir hundreds of times inside
    # one run would cost more than it saves (see dream_cache.store).
    dream_cache.evict()
    return out


# NOTE on negative prompts: there are none here, on purpose. Both Turbo models run at
# guidance_scale 0, and every one of these pipelines gates CFG on `guidance_scale > 0`
# (Z-Image) / `> 1` (SD) — so a negative prompt is silently INERT. stylize_frames still
# passes one; it does nothing there either, and is kept only because its remote twin
# takes it positionally. Turning negatives on would mean raising guidance_scale, which
# doubles the per-frame cost and degrades distilled models: a deliberate feature with a
# card control, if ever wanted, not an inherited no-op.


# --------------------------------------------------------------------------- #
# Control-image extractors that need a neural model (the Extract card's model
# kinds; canny/soft-edge are pure OpenCV in graph_render). Lazy singleton, same
# discipline as the pipelines above.
# --------------------------------------------------------------------------- #
DEPTH_MODEL = os.environ.get("DEPTH_MODEL", "depth-anything/Depth-Anything-V2-Small-hf")


def _depth_estimator():
    key = "depth"
    with _lock:
        if key in _pipes:
            return _pipes[key]
        try:
            from transformers import pipeline
        except ImportError as e:
            raise RuntimeError(
                "depth extraction needs the transformers stack — `pip install -r requirements.txt`"
            ) from e
        device = _pick_device()
        try:
            est = pipeline("depth-estimation", model=DEPTH_MODEL, device=device)
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(f"could not load depth model '{DEPTH_MODEL}': {e}") from e
        log.info("imagegen: loaded depth model %s on %s", DEPTH_MODEL, device)
        _pipes[key] = est
        return est


def depth_frames(frames):
    """Video clip [T,h,w,3] uint8 → depth-map control clip [T,h,w,3] uint8 (near = bright).
    Runs a small depth model per frame under `_infer_lock` (serialised on the one GPU)."""
    import numpy as np
    from PIL import Image

    ep = app_settings.remote_endpoint("depth")
    if ep is not None:
        from . import remote_client

        return remote_client.depth_remote(frames, *ep)
    est = _depth_estimator()
    out = np.empty_like(frames)
    for i in range(len(frames)):
        with _infer_lock:
            d = est(Image.fromarray(np.ascontiguousarray(frames[i])))["depth"]
        dm = np.asarray(d, np.float32)
        lo, hi = float(dm.min()), float(dm.max())
        norm = (dm - lo) / (hi - lo + 1e-6)
        g = (norm * 255).astype(np.uint8)
        out[i] = np.repeat(g[..., None], 3, axis=2)
    return out
