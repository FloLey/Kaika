"""Step 0 prototype — diffusion feedback-loop stylization of fluid frames.

STANDALONE de-risk script (NOT imported by the app). It proves the loop from
specs/ai-stylize/BRIEF-image-video-gen.md §8 works on this Mac: load cached fluid frames, run an
img2img + ControlNet feedback loop with an SD-Turbo-class model on MPS, and write
an mp4. See specs/ai-stylize/step-0-prototype.md for the plan and exit gate.

Deps beyond the app: opencv-python-headless + accelerate (installed into .venv for
the prototype; deliberately NOT added to the pinned requirements.txt).

Examples
--------
  # list cached fluid clips (frame count / grid / motion) so you can pick one
  .venv/bin/python scripts/ai_stylize_prototype.py --list

  # baseline Workflow A (no warp) on 240 frames at denoise 0.45
  .venv/bin/python scripts/ai_stylize_prototype.py --source d0e3b447c35129f5 \
      --frames 240 --denoise 0.45 --prompt "flowing molten lava, glowing embers"

  # denoise sweep + LAB match + fixed noise, for the flicker comparison
  .venv/bin/python scripts/ai_stylize_prototype.py --source d0e3b447c35129f5 \
      --frames 120 --sweep 0.30,0.45,0.60 --lab 10 --fixed-noise
"""

from __future__ import annotations

import argparse
import glob
import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / "data" / "fluid_cache"
OUT_DIR = ROOT / "data" / "ai_stylize_proto"

# SD-Turbo is SD-2.1-based, so it needs a *2.1* ControlNet (the common lllyasviel
# canny checkpoints are SD-1.5 and will NOT condition correctly). This pairing is
# exactly the open risk Step 0 exists to settle — swap via --model / --controlnet.
DEFAULT_MODEL = "stabilityai/sd-turbo"
DEFAULT_CONTROLNET = "thepowefuldeez/sd21-controlnet-canny"
DEFAULT_PROMPT = "flowing molten lava, glowing embers, dark cinematic background, highly detailed"
DEFAULT_NEG = "blurry, low quality, text, watermark, frame border"


# --------------------------------------------------------------------------- #
# Source frames
# --------------------------------------------------------------------------- #
def list_clips() -> None:
    """Print cached fluid clips with a crude motion metric to help pick a source."""
    files = sorted(glob.glob(str(CACHE_DIR / "*.npy")), key=os.path.getsize, reverse=True)
    print(f"{'key':18} {'shape':22} {'motion':>7} {'bright':>7}")
    for f in files[:40]:
        a = np.load(f, mmap_mode="r")
        if a.ndim != 4 or a.shape[0] < 3:
            continue
        mot = float(np.abs(a[len(a) // 2].astype(np.int16) - a[0].astype(np.int16)).mean())
        print(f"{Path(f).stem:18} {str(a.shape):22} {mot:7.1f} {float(a.mean()):7.1f}")


def load_source(source: str, frames: int) -> np.ndarray:
    """Load a cached fluid clip (`data/fluid_cache/<key>.npy` or a path) → [T,h,w,3]
    uint8, dye-on-black at grid resolution, truncated to `frames`."""
    p = Path(source)
    if not p.exists():
        p = CACHE_DIR / f"{source}.npy"
    if not p.exists():
        sys.exit(f"source not found: {source} (try --list)")
    arr = np.load(p, mmap_mode="r")
    if arr.ndim != 4 or arr.shape[-1] != 3:
        sys.exit(f"unexpected source shape {arr.shape} (want [T,h,w,3])")
    return np.asarray(arr[: max(1, frames)])


def work_dims(gh: int, gw: int, short: int) -> tuple[int, int]:
    """Working (H, W) with the grid's aspect, short side ≈ `short`, each a multiple
    of 8 (SD VAE constraint)."""
    if gw <= gh:  # portrait: width is the short side
        w = short
        h = round(short * gh / gw)
    else:
        h = short
        w = round(short * gw / gh)
    r8 = lambda v: max(64, int(round(v / 8)) * 8)  # noqa: E731
    return r8(h), r8(w)


# --------------------------------------------------------------------------- #
# Loop building blocks (specs/ai-stylize/BRIEF-image-video-gen.md §7, §11)
# --------------------------------------------------------------------------- #
def extract_control(frame_rgb: np.ndarray, cv2) -> "PIL.Image.Image":  # noqa: F821
    """Density → Canny edges → the ControlNet control image (the brief's helper)."""
    from PIL import Image

    gray = cv2.cvtColor(frame_rgb, cv2.COLOR_RGB2GRAY)
    edges = cv2.Canny(gray, 80, 160)
    return Image.fromarray(cv2.cvtColor(edges, cv2.COLOR_GRAY2RGB))


def match_colors_lab(img: np.ndarray, reference: np.ndarray, cv2) -> np.ndarray:
    """Recolor `img` to `reference`'s per-channel LAB statistics — the brief's most
    effective anti-drift remedy (§11)."""
    lab = cv2.cvtColor(img, cv2.COLOR_RGB2LAB).astype(np.float32)
    ref = cv2.cvtColor(reference, cv2.COLOR_RGB2LAB).astype(np.float32)
    for c in range(3):
        m, s = lab[..., c].mean(), lab[..., c].std() + 1e-6
        lab[..., c] = (lab[..., c] - m) / s * ref[..., c].std() + ref[..., c].mean()
    return cv2.cvtColor(np.clip(lab, 0, 255).astype(np.uint8), cv2.COLOR_LAB2RGB)


def auto_steps(denoise: float, override: int | None) -> int:
    """SD-Turbo img2img runs `int(steps*strength)` denoising steps — so a low strength
    with steps=2 rounds to ZERO steps and errors. Pick steps for ~2 effective steps."""
    if override:
        return override
    return max(2, round(2.0 / max(0.05, denoise)))


# --------------------------------------------------------------------------- #
# Pipeline
# --------------------------------------------------------------------------- #
def build_pipe(model: str, controlnet: str):
    import torch
    from diffusers import ControlNetModel, StableDiffusionControlNetImg2ImgPipeline

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    dtype = torch.float16 if device == "mps" else torch.float32
    print(f"loading {model} + controlnet {controlnet} on {device} ({dtype})…", flush=True)
    cnet = ControlNetModel.from_pretrained(controlnet, torch_dtype=dtype)
    pipe = StableDiffusionControlNetImg2ImgPipeline.from_pretrained(
        model, controlnet=cnet, torch_dtype=dtype, safety_checker=None
    ).to(device)
    pipe.set_progress_bar_config(disable=True)
    return pipe, device


def run(cfg, pipe, device, src: np.ndarray, tag: str) -> Path:
    """Run the feedback loop over `src` with one config → an mp4. Returns the path."""
    import cv2
    import torch
    from PIL import Image

    gh, gw = src.shape[1], src.shape[2]
    H, W = work_dims(gh, gw, cfg.res)
    resize = lambda f: cv2.resize(f, (W, H), interpolation=cv2.INTER_LINEAR)  # noqa: E731
    steps = auto_steps(cfg.denoise, cfg.steps)
    # Fixed generator (reused every frame) = the StreamDiffusion "same noise" trick.
    gen = torch.Generator(device="cpu").manual_seed(cfg.seed)

    def infer(init_rgb, control_img, strength):
        g = torch.Generator(device="cpu").manual_seed(cfg.seed) if cfg.fixed_noise else gen
        out = pipe(
            prompt=cfg.prompt,
            negative_prompt=cfg.neg,
            image=Image.fromarray(init_rgb),
            control_image=control_img,
            strength=float(strength),
            num_inference_steps=steps,
            guidance_scale=0.0,  # SD-Turbo is distilled guidance-free
            controlnet_conditioning_scale=float(cfg.control_scale),
            generator=g,
        )
        return np.asarray(out.images[0])

    frames_out = np.empty((len(src), H, W, 3), np.uint8)
    # Frame 0 = anchor: high strength (no previous frame yet), defines the style/palette.
    dye0 = resize(src[0])
    frames_out[0] = infer(dye0, extract_control(dye0, cv2), 0.9)
    anchor = frames_out[0].copy()
    prev = frames_out[0]

    times = []
    for t in range(1, len(src)):
        dye = resize(src[t])
        # init image: previous OUTPUT (feedback loop, Workflow A) OR the current dye
        # directly (per-frame restyle — no loop damping, tracks motion exactly but can
        # flicker). --per-frame isolates "can the model restyle the fluid" from the loop.
        init = dye if cfg.per_frame else prev
        if cfg.noise_inject > 0:  # perturb the init in pixel space to break attractors
            noise = np.random.default_rng(cfg.seed + t).normal(
                0, cfg.noise_inject * 255, init.shape
            )
            init = np.clip(init.astype(np.float32) + noise, 0, 255).astype(np.uint8)
        t0 = time.time()
        out = infer(init, extract_control(dye, cv2), cfg.denoise)
        times.append(time.time() - t0)
        if cfg.lab and t % cfg.lab == 0:
            out = match_colors_lab(out, anchor, cv2)
        frames_out[t] = out
        prev = out
        if t % 24 == 0 or t == len(src) - 1:
            spf = np.mean(times)
            print(
                f"  [{tag}] {t + 1}/{len(src)}  {spf:.2f}s/frame  "
                f"eta {spf * (len(src) - t) / 60:.1f}min",
                flush=True,
            )

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / f"{tag}.mp4"
    encode(frames_out, cfg.fps, out_path)
    spf = float(np.mean(times)) if times else 0.0
    total = float(np.sum(times))
    print(
        f"  [{tag}] DONE  {W}x{H}  steps={steps}  {spf:.2f}s/frame  "
        f"total {total:.0f}s ({total / 60:.1f}min)  -> {out_path}",
        flush=True,
    )
    return out_path


def encode(frames: np.ndarray, fps: int, path: Path) -> None:
    """RGB [T,H,W,3] → web-playable h264 mp4 via system ffmpeg (rawvideo on stdin)."""
    h, w = frames.shape[1], frames.shape[2]
    cmd = [
        "ffmpeg", "-y", "-v", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
        "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(path),
    ]  # fmt: skip
    proc = subprocess.run(cmd, input=frames.tobytes(), capture_output=True)
    if proc.returncode != 0:
        sys.exit("ffmpeg failed:\n" + proc.stderr.decode()[-2000:])


# --------------------------------------------------------------------------- #
def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--list", action="store_true", help="list cached fluid clips and exit")
    ap.add_argument("--source", help="cache key (data/fluid_cache/<key>.npy) or a path")
    ap.add_argument("--frames", type=int, default=240, help="max frames to stylize (240 ≈ 10s)")
    ap.add_argument(
        "--res", type=int, default=512, help="working short-side px (SD-Turbo native 512)"
    )
    ap.add_argument("--denoise", type=float, default=0.45, help="img2img strength (the key dial)")
    ap.add_argument("--sweep", help="comma list of denoise values → one clip each")
    ap.add_argument(
        "--steps", type=int, default=0, help="inference steps (0 = auto for ~2 effective)"
    )
    ap.add_argument("--control-scale", type=float, default=0.8, help="ControlNet strength (0=off)")
    ap.add_argument(
        "--per-frame",
        action="store_true",
        help="restyle each dye frame directly (no feedback loop damping)",
    )
    ap.add_argument(
        "--noise-inject",
        type=float,
        default=0.0,
        help="add gaussian pixel noise to the init each frame (0..1, breaks attractors)",
    )
    ap.add_argument("--lab", type=int, default=0, help="LAB-match to anchor every N frames (0=off)")
    ap.add_argument("--fixed-noise", action="store_true", help="reuse one noise seed every frame")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--controlnet", default=DEFAULT_CONTROLNET)
    ap.add_argument("--prompt", default=DEFAULT_PROMPT)
    ap.add_argument("--neg", default=DEFAULT_NEG)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--fps", type=int, default=24)
    cfg = ap.parse_args()

    if cfg.list:
        list_clips()
        return
    if not cfg.source:
        sys.exit("give --source <key> (or --list to see options)")

    src = load_source(cfg.source, cfg.frames)
    print(f"source {cfg.source}: {src.shape[0]} frames @ grid {src.shape[2]}x{src.shape[1]}")
    pipe, device = build_pipe(cfg.model, cfg.controlnet)

    values = [float(v) for v in cfg.sweep.split(",")] if cfg.sweep else [cfg.denoise]
    stem = Path(cfg.source).stem  # basename only — the source may be a path with slashes
    for v in values:
        cfg.denoise = v
        lab = f"_lab{cfg.lab}" if cfg.lab else ""
        fn = "_fn" if cfg.fixed_noise else ""
        pf = "_pf" if cfg.per_frame else ""
        tag = f"{stem}_d{v:.2f}_c{cfg.control_scale:.1f}{pf}_r{cfg.res}{lab}{fn}"
        run(cfg, pipe, device, src, tag)


if __name__ == "__main__":
    main()
