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
        device = "mps" if torch.backends.mps.is_available() else "cpu"
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
                dtype = torch.float16 if device == "mps" else torch.float32
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
    aw, ah = (aspect or (1, 1))
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
