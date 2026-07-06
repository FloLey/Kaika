"""Local text-to-image generation for the Image gen card's ✨ generate.

Runs Tongyi-MAI's **Z-Image-Turbo** (a ~6B-parameter DiT, ~33 GB of weights,
8 denoising steps) fully locally via diffusers' `ZImagePipeline`. It's far
heavier than a distilled SD-Turbo: the first call downloads ~33 GB and loads it
in bfloat16 (~16 GB resident); on Apple-Silicon MPS a 1024 px image is on the
order of minutes, not real-time. Everything is LAZY: diffusers imports and the
pipeline load happen on the first generate call, so the app boots (and runs
fine) without the packages or the model — generation just raises a clean message
the job surfaces on the card (the `llm.py` raise-and-fallback shape).

Determinism: generation is seeded (`torch.Generator`), so the same
prompt/seed/size reproduces the same image — and the results are stored as
content-addressed assets anyway, so re-generation never mutates an existing URL
(which would silently defeat the render cache).
"""

from __future__ import annotations

import logging
import os
import threading

log = logging.getLogger("kaika.imagegen")

MODEL = os.environ.get("IMAGEGEN_MODEL", "Tongyi-MAI/Z-Image-Turbo")
# Z-Image-Turbo is an 8-step (8 DiT forwards) distilled model; guidance is
# disabled (guidance_scale=0.0), like other turbo models.
_STEPS = int(os.environ.get("IMAGEGEN_STEPS", "8"))

_lock = threading.Lock()
_pipe = None  # lazy singleton — loading takes tens of seconds + GBs, do it once


def _load_pipe():
    """Import diffusers + load the pipeline on first use (cached). Raises a clean
    RuntimeError when the stack isn't installed or the model can't load — the
    caller (a background job) surfaces the message on the card."""
    global _pipe
    with _lock:
        if _pipe is not None:
            return _pipe
        try:
            import torch
            from diffusers import ZImagePipeline
        except ImportError as e:
            raise RuntimeError(
                "image generation needs the diffusers stack (with ZImagePipeline) — "
                "`pip install -r requirements.txt` (diffusers/transformers/safetensors)"
            ) from e
        device = "mps" if torch.backends.mps.is_available() else "cpu"
        # Z-Image ships fp32 weights; bfloat16 halves the resident footprint and is
        # the model's recommended runtime dtype (works on MPS and CPU).
        dtype = torch.bfloat16
        try:
            # low_cpu_mem_usage=False: load weights directly (not via accelerate's
            # meta-device path), which ZImagePipeline expects and which avoids
            # meta-tensor issues on MPS.
            pipe = ZImagePipeline.from_pretrained(
                MODEL, torch_dtype=dtype, low_cpu_mem_usage=False
            )
        except Exception as e:  # noqa: BLE001 — network/model errors get one clean message
            raise RuntimeError(f"could not load image model '{MODEL}': {e}") from e
        pipe = pipe.to(device)
        log.info("imagegen: loaded %s on %s (%s)", MODEL, device, dtype)
        _pipe = pipe
        return _pipe


def generate(prompt: str, seed: int = 1, count: int = 1, size: int = 640) -> list:
    """`count` PIL images for `prompt`, seeded from `seed` (image i uses seed+i so a
    batch is distinct but reproducible). `size` is the square edge (multiple of 8)."""
    import torch  # torch is a hard app dependency (demucs) — safe to import here

    pipe = _load_pipe()
    # Z-Image is 1024-native; round to a multiple of 16 (the DiT/VAE want a coarser
    # grid than SD's /8) and cap at 1024.
    size = max(256, min(1024, int(size) // 16 * 16))
    out = []
    for i in range(max(1, int(count))):
        gen = torch.Generator(device="cpu").manual_seed(int(seed) + i)
        result = pipe(
            prompt=str(prompt),
            num_inference_steps=_STEPS,
            guidance_scale=0.0,  # Z-Image-Turbo is distilled guidance-free
            width=size,
            height=size,
            generator=gen,
        )
        out.append(result.images[0])
    return out
