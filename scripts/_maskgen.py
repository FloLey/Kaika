"""Option 3: masked generation — inject fixed noise (fresh generation) ONLY inside the
fluid, keep black outside. Uses the ControlNet inpaint pipeline: mask = fluid density.

Fresh detail like "start from noise", but confined to the fluid like "start from fluid".
"""

import sys, subprocess, time
from pathlib import Path
import numpy as np, cv2

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ai_stylize_prototype as P

OUT = Path("data/ai_stylize_proto")


def build_inpaint(model, controlnet):
    import torch
    from diffusers import ControlNetModel, StableDiffusionControlNetInpaintPipeline

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    dt = torch.float16 if device == "mps" else torch.float32
    cnet = ControlNetModel.from_pretrained(controlnet, torch_dtype=dt)
    pipe = StableDiffusionControlNetInpaintPipeline.from_pretrained(
        model, controlnet=cnet, torch_dtype=dt, safety_checker=None
    ).to(device)
    pipe.set_progress_bar_config(disable=True)
    return pipe


def density_mask(dye, W, H):
    """Fluid density -> soft white-where-fluid mask (where to generate)."""
    g = (
        cv2.cvtColor(cv2.resize(np.asarray(dye), (W, H)), cv2.COLOR_RGB2GRAY).astype(np.float32)
        / 255.0
    )
    g = cv2.GaussianBlur(g, (0, 0), 3)
    return np.clip(g * 3.0, 0, 1)  # lift faint dye into the mask; hard black stays out


def run(src_key, prompt, tag, denoise=1.0, control_scale=0.8, frames=120, res=384, seed=1):
    from PIL import Image
    import torch

    pipe = build_inpaint(P.DEFAULT_MODEL, P.DEFAULT_CONTROLNET)
    src = P.load_source(src_key, frames)
    gh, gw = src.shape[1], src.shape[2]
    H, W = P.work_dims(gh, gw, res)
    steps = P.auto_steps(denoise, 0)
    black = Image.fromarray(np.zeros((H, W, 3), np.uint8))
    out = np.empty((len(src), H, W, 3), np.uint8)
    times = []
    for t in range(len(src)):
        dye = cv2.resize(np.asarray(src[t]), (W, H), interpolation=cv2.INTER_LINEAR)
        mask = Image.fromarray((density_mask(src[t], W, H) * 255).astype(np.uint8))
        control = P.extract_control(dye, cv2)
        gen = torch.Generator(device="cpu").manual_seed(seed)  # fixed noise every frame
        t0 = time.time()
        res_img = pipe(
            prompt=prompt,
            negative_prompt=P.DEFAULT_NEG,
            image=black,
            mask_image=mask,
            control_image=control,
            height=H,
            width=W,
            strength=float(denoise),
            num_inference_steps=steps,
            guidance_scale=0.0,
            controlnet_conditioning_scale=float(control_scale),
            generator=gen,
        ).images[0]
        times.append(time.time() - t0)
        out[t] = np.asarray(res_img)
        if t % 30 == 0 or t == len(src) - 1:
            print(f"  [{tag}] {t+1}/{len(src)} {np.mean(times):.2f}s/f", flush=True)
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
    LGHT = "lightning bolts, electric plasma arcs, glowing energy, dark stormy sky, cinematic"
    LAVA = "molten lava, glowing embers, flowing magma, dark background, cinematic"
    run("b64f1a34f1067c83", LGHT, "MASKGEN_sparse_lightning")
    run("d0e3b447c35129f5", LAVA, "MASKGEN_dense_lava")
