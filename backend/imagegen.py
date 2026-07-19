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


def model_label(model: str) -> str:
    """Human label for a model id (falls back to the id itself)."""
    return (MODELS.get(model) or {}).get("label", model)


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


def _load_stylize_pipe(model: str, inpaint: bool, control: bool):
    key = f"{model}:{'inpaint' if inpaint else 'img2img'}{':ctrl' if control else ''}"
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
                    )

                    cn = ControlNetModel.from_pretrained(cn_repo, torch_dtype=dtype)
                    cls = (
                        StableDiffusionControlNetInpaintPipeline
                        if inpaint
                        else StableDiffusionControlNetImg2ImgPipeline
                    )
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


def _density_mask(dye):
    """Soft 0..1 mask of where the clip has substance (its luminance) — confines a repaint
    to the fluid's shape so its black background survives untouched."""
    import cv2
    import numpy as np

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
    import cv2
    import torch
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
    pipe = _load_stylize_pipe(model, inpaint, use_control)
    # Z-Image's ControlNet pipeline ships as txt2img + control (no image/strength/mask args), so
    # below we hand-roll img2img on it: seeded `latents` + a truncated sigma schedule. Draft's
    # ControlNet pipeline is img2img natively.
    zimage_control = use_control and spec["kind"] == "zimage"
    if zimage_control:
        from diffusers.pipelines.z_image.pipeline_z_image_controlnet import (  # lazy, like the rest
            get_default_z_image_sigmas,
            retrieve_latents,
        )

        device = pipe._execution_device
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
            sub = _zimage_sigmas(get_default_z_image_sigmas(int(spec["steps"])), strength)
            # The scheduler REMAPS requested sigmas (shift=3.0: 0.875 → 0.955). Noise with the
            # sigma it will actually use — noising with the raw one under-noises the latents, so
            # the model "denoises" absent noise and just reconstructs the input.
            pipe.scheduler.set_timesteps(sigmas=sub, device=device)
            sigma0 = float(pipe.scheduler.sigmas[0])
            px = pipe.image_processor.preprocess(Image.fromarray(dye), height=H, width=W)
            z0 = retrieve_latents(
                pipe.vae.encode(px.to(device, dtype=pipe.vae.dtype)),
                generator=gen,
                sample_mode="argmax",
            )
            z0 = (z0 - pipe.vae.config.shift_factor) * pipe.vae.config.scaling_factor
            noise = torch.randn(z0.shape, generator=gen, dtype=torch.float32).to(
                device, dtype=z0.dtype
            )
            latents = sigma0 * noise + (1.0 - sigma0) * z0  # the scheduler's scale_noise convention
            kw = dict(
                prompt=str(prompt),
                negative_prompt=negative,
                height=H,
                width=W,
                num_inference_steps=len(sub),
                guidance_scale=0.0,
                generator=gen,
                control_image=Image.fromarray(cimg),
                controlnet_conditioning_scale=float(control_scale),
                latents=latents.to(pipe.transformer.dtype),
                sigmas=sub,
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
