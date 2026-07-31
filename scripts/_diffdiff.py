"""Differential diffusion: per-pixel noise = fluid density. High density -> full fresh
generation; faint -> faint; black -> black. Continuous gradient (not a binary mask).

Each denoising step keeps low-density pixels frozen at the noised-black latent, so they
never accumulate generation; high-density pixels denoise fully. Mid density -> partial.
"""

import sys, subprocess, time
from pathlib import Path
import numpy as np, cv2, torch
from PIL import Image

sys.path.insert(0, "scripts")
import ai_stylize_prototype as P

OUT = Path("data/ai_stylize_proto")
pipe, device = P.build_pipe(P.DEFAULT_MODEL, P.DEFAULT_CONTROLNET)
DT = torch.float16

_state = {}


def cb(pp, i, t, kw):
    lat = kw["latents"]
    n = len(pp.scheduler.timesteps)
    if i < n - 1:
        p = (i + 1) / n  # progress 0..1
        active = (_state["cm"] >= (1.0 - p)).to(lat.dtype)  # hard per-pixel threshold
        sig = pp.scheduler.sigmas[i + 1].to(lat.dtype)
        frozen = _state["img"] + _state["noise"] * sig
        kw["latents"] = active * lat + (1.0 - active) * frozen
    return kw


def density_latent(dye, lh, lw):
    # per-pixel STRENGTH = fluid INTENSITY (value = max channel, so a vivid hue reads high)
    v = cv2.resize(np.asarray(dye), (lw * 8, lh * 8)).astype(np.float32).max(axis=2) / 255.0
    v = np.clip(cv2.GaussianBlur(v, (0, 0), 2) / 0.28, 0, 1)  # gentler: mid dye reaches full
    v = cv2.resize(v, (lw, lh))
    return torch.from_numpy(v)[None, None].to(device, DT)


def render(src_key, prompt, tag, steps=8, control_scale=0.8, frames=60, res=384, seed=1):
    src = P.load_source(src_key, frames)
    H, W = P.work_dims(src.shape[1], src.shape[2], res)
    lh, lw = H // 8, W // 8
    black = Image.fromarray(np.zeros((H, W, 3), np.uint8))
    # black-image latent (constant) + one fixed noise field -> coherence
    bt = torch.full((1, 3, H, W), -1.0, device=device, dtype=DT)
    img_lat = pipe.vae.encode(bt).latent_dist.mean * pipe.vae.config.scaling_factor
    noise = torch.randn(img_lat.shape, generator=torch.Generator("cpu").manual_seed(seed)).to(
        device, DT
    )
    _state["img"], _state["noise"] = img_lat, noise
    out = np.empty((frames, H, W, 3), np.uint8)
    times = []
    for t in range(frames):
        dye = cv2.resize(np.asarray(src[t]), (W, H), interpolation=cv2.INTER_LINEAR)
        _state["cm"] = density_latent(src[t], lh, lw)
        control = P.extract_control(dye, cv2)
        gen = torch.Generator("cpu").manual_seed(seed)
        t0 = time.time()
        img = pipe(
            prompt=prompt,
            negative_prompt=P.DEFAULT_NEG,
            image=black,
            control_image=control,
            height=H,
            width=W,
            strength=1.0,
            num_inference_steps=steps,
            guidance_scale=0.0,
            controlnet_conditioning_scale=control_scale,
            generator=gen,
            callback_on_step_end=cb,
            callback_on_step_end_tensor_inputs=["latents"],
        ).images[0]
        times.append(time.time() - t0)
        out[t] = np.asarray(img)
        if t % 20 == 0 or t == frames - 1:
            print(f"  [{tag}] {t+1}/{frames} {np.mean(times):.2f}s/f", flush=True)
    OUT.mkdir(parents=True, exist_ok=True)
    p = OUT / f"{tag}.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-s",
            f"{W}x{H}",
            "-r",
            "24",
            "-i",
            "-",
            "-an",
            "-c:v",
            "libx264",
            "-crf",
            "28",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(p),
        ],
        input=out.tobytes(),
        check=True,
    )
    print(f"  [{tag}] DONE {W}x{H} {np.mean(times):.2f}s/f -> {p}", flush=True)


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 60
    render(
        "d0e3b447c35129f5",
        "molten lava, glowing embers, flowing magma, dark background, cinematic",
        "DIFF_dense_lava",
        frames=n,
    )
