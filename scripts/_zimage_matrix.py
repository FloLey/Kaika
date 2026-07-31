"""Full HD (Z-Image Turbo) matrix render. Recipe 4 (inpaint) first — the star — then
recipe 3 (img2img), then recipe 1 (txt2img). Saves each small clip immediately so partial
progress survives. Post-processing (recipes 5, 2) + artifact happen afterwards.
"""

import sys, time, subprocess
from pathlib import Path
import numpy as np, cv2, torch
from PIL import Image

HD = "Tongyi-MAI/Z-Image-Turbo"
W, H = 448, 800  # HD-ish, faster than 512x960
FRAMES = 48
OUT = Path("data/ai_stylize_proto/small")
FLU = {"dense": ("d0e3b447c35129f5", 20), "sparse": ("b64f1a34f1067c83", 0)}  # (key, start frame)
PROMPTS = {
    "lava": "molten lava, glowing embers, flowing magma, dark background, cinematic",
    "flowers": "flowers, blooming roses and peonies, lush colorful petals, floral, dark background",
    "lightning": "lightning bolts, electric plasma arcs, glowing energy, dark stormy sky, cinematic",
    "trees": "lush green forest canopy, trees and foliage, branches, misty light, cinematic",
}
PK = list(PROMPTS)

from diffusers import ZImageImg2ImgPipeline, ZImageInpaintPipeline, ZImagePipeline

print("loading Z-Image (img2img/inpaint/txt2img share weights)…", flush=True)
i2i = ZImageImg2ImgPipeline.from_pretrained(
    HD, torch_dtype=torch.bfloat16, low_cpu_mem_usage=False
).to("mps")
i2i.set_progress_bar_config(disable=True)
inp = ZImageInpaintPipeline(**i2i.components)
inp.set_progress_bar_config(disable=True)
t2i = ZImagePipeline(**i2i.components)
t2i.set_progress_bar_config(disable=True)
print("loaded.", flush=True)


def frames_of(key, start):
    a = np.load(f"data/fluid_cache/{key}.npy", mmap_mode="r")
    idx = [min(start + i, len(a) - 1) for i in range(FRAMES)]
    return [cv2.resize(np.asarray(a[t]), (W, H), interpolation=cv2.INTER_LINEAR) for t in idx]


def mask_img(dye):
    g = cv2.cvtColor(dye, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
    return Image.fromarray(
        (np.clip(cv2.GaussianBlur(g, (0, 0), 3) * 3, 0, 1) * 255).astype(np.uint8)
    )


def encode(frames, name):
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
            "30",
            "-vf",
            "scale=224:-2",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(OUT / name),
        ],
        input=frames.tobytes(),
        check=True,
    )


def render(recipe, fk, pk):
    key, start = FLU[fk]
    dyes = frames_of(key, start)
    prompt = PROMPTS[pk]
    black = Image.fromarray(np.zeros((H, W, 3), np.uint8))
    out = np.empty((FRAMES, H, W, 3), np.uint8)
    t0 = time.time()
    for i, dye in enumerate(dyes):
        g = torch.Generator("cpu").manual_seed(1)
        if recipe == "mask":
            img = inp(
                prompt=prompt,
                image=black,
                mask_image=mask_img(dye),
                strength=1.0,
                num_inference_steps=8,
                guidance_scale=0.0,
                generator=g,
            ).images[0]
        elif recipe == "fluid":
            img = i2i(
                prompt=prompt,
                image=Image.fromarray(dye),
                strength=0.8,
                num_inference_steps=8,
                guidance_scale=0.0,
                generator=g,
            ).images[0]
        else:  # noise (txt2img, fluide-indépendant)
            img = t2i(
                prompt=prompt,
                height=H,
                width=W,
                num_inference_steps=8,
                guidance_scale=0.0,
                generator=g,
            ).images[0]
        out[i] = np.asarray(img)
    encode(out, f"V2hd_{recipe}_{fk}_{pk}.mp4")
    print(f"  [{recipe} {fk} {pk}] done {(time.time()-t0)/FRAMES:.1f}s/f", flush=True)


# Priority order: recipe 4 (all) -> recipe 3 (all) -> recipe 1 (all)
for recipe in ("mask", "fluid", "noise"):
    for fk in FLU:
        for pk in PK:
            render(recipe, fk, pk)
    print(f"=== recipe '{recipe}' complete ===", flush=True)
print("ZIMAGE MATRIX DONE", flush=True)
