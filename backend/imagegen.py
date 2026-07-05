"""Local text-to-image generation for the Image gen card's ✨ generate.

Runs a small distilled Stable Diffusion (default `stabilityai/sd-turbo`, ~2 GB,
1-4 denoising steps — near-real-time on Apple-Silicon MPS at 512-768 px) fully
locally. Everything is LAZY: diffusers imports and the pipeline load happen on
the first generate call, so the app boots (and runs fine) without the packages
or the model — generation just raises a clean message the job surfaces on the
card (the `llm.py` raise-and-fallback shape).

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

MODEL = os.environ.get("IMAGEGEN_MODEL", "stabilityai/sd-turbo")
# sd-turbo is a 1-4 step model; guidance is disabled (it was distilled without it).
_STEPS = int(os.environ.get("IMAGEGEN_STEPS", "2"))

_lock = threading.Lock()
_pipe = None  # lazy singleton — loading takes seconds + RAM, do it once


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
            from diffusers import AutoPipelineForText2Image
        except ImportError as e:
            raise RuntimeError(
                "image generation needs the diffusers stack — "
                "`pip install -r requirements.txt` (diffusers/transformers/safetensors)"
            ) from e
        device = "mps" if torch.backends.mps.is_available() else "cpu"
        dtype = torch.float16 if device == "mps" else torch.float32
        try:
            pipe = AutoPipelineForText2Image.from_pretrained(MODEL, torch_dtype=dtype)
        except Exception as e:  # noqa: BLE001 — network/model errors get one clean message
            raise RuntimeError(f"could not load image model '{MODEL}': {e}") from e
        pipe = pipe.to(device)
        log.info("imagegen: loaded %s on %s", MODEL, device)
        _pipe = pipe
        return _pipe


def generate(prompt: str, seed: int = 1, count: int = 1, size: int = 640) -> list:
    """`count` PIL images for `prompt`, seeded from `seed` (image i uses seed+i so a
    batch is distinct but reproducible). `size` is the square edge (multiple of 8)."""
    import torch  # torch is a hard app dependency (demucs) — safe to import here

    pipe = _load_pipe()
    size = max(256, min(1024, int(size) // 8 * 8))
    out = []
    for i in range(max(1, int(count))):
        gen = torch.Generator(device="cpu").manual_seed(int(seed) + i)
        result = pipe(
            prompt=str(prompt),
            num_inference_steps=_STEPS,
            guidance_scale=0.0,  # sd-turbo is distilled guidance-free
            width=size,
            height=size,
            generator=gen,
        )
        out.append(result.images[0])
    return out
