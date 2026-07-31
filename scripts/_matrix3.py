"""Full matrix: 2 fluids x 4 prompts x 3 versions (start-noise / start-fluid / masked-gen).
Reuses existing clips (copied to canonical V2_ names) and renders only the missing ones.
"""

import sys, subprocess, time, shutil, gc, types
from pathlib import Path
import numpy as np, cv2

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ai_stylize_prototype as P
import _maskgen as M

OUT = Path("data/ai_stylize_proto")
DENSE, SPARSE = "d0e3b447c35129f5", "b64f1a34f1067c83"
FLU = {"dense": DENSE, "sparse": SPARSE}
PROMPTS = {
    "lava": "molten lava, glowing embers, flowing magma, dark background, cinematic",
    "flowers": "flowers, blooming roses and peonies, lush colorful petals, floral, dark background",
    "lightning": "lightning bolts, electric plasma arcs, glowing energy, dark stormy sky, cinematic",
    "trees": "lush green forest canopy, trees and foliage, branches, misty light, cinematic",
}
PK = list(PROMPTS)
canon = lambda ver, fk, pk: OUT / f"V2_{ver}_{fk}_{pk}.mp4"

# 1. Adopt existing renders under canonical names (no recompute).
EXISTING = {
    ("noise", "dense", "lava"): "d0e3b447c35129f5_d1.00_c0.8_pf_r384_fn.mp4",
    ("noise", "dense", "flowers"): "d0e3b447c35129f5_d1.00_c0.7_pf_r384_fn.mp4",
    ("noise", "dense", "lightning"): "MTX_d0e3b447c35129f5_lightning.mp4",
    ("noise", "dense", "trees"): "MTX_d0e3b447c35129f5_trees.mp4",
    ("noise", "sparse", "lava"): "MTX_b64f1a34f1067c83_lava.mp4",
    ("noise", "sparse", "flowers"): "MTX_b64f1a34f1067c83_flowers.mp4",
    ("noise", "sparse", "lightning"): "MTX_b64f1a34f1067c83_lightning.mp4",
    ("noise", "sparse", "trees"): "MTX_b64f1a34f1067c83_trees.mp4",
    ("fluid", "sparse", "lightning"): "b64f1a34f1067c83_d0.80_c0.3_pf_r384_fn.mp4",
    ("mask", "sparse", "lightning"): "MASKGEN_sparse_lightning.mp4",
    ("mask", "dense", "lava"): "MASKGEN_dense_lava.mp4",
}
for (ver, fk, pk), fn in EXISTING.items():
    dst, src = canon(ver, fk, pk), OUT / fn
    if src.exists() and not dst.exists():
        shutil.copy(src, dst)

# 2. start-fluid (img2img, denoise 0.8, control 0.3) — the missing ones.
fluid_jobs = [(fk, pk) for fk in FLU for pk in PK if not canon("fluid", fk, pk).exists()]
if fluid_jobs:
    pipe, device = P.build_pipe(P.DEFAULT_MODEL, P.DEFAULT_CONTROLNET)
    for fk, pk in fluid_jobs:
        src = P.load_source(FLU[fk], 120)
        cfg = types.SimpleNamespace(
            prompt=PROMPTS[pk],
            neg=P.DEFAULT_NEG,
            res=384,
            denoise=0.8,
            steps=0,
            control_scale=0.3,
            per_frame=True,
            noise_inject=0.0,
            lab=0,
            fixed_noise=True,
            seed=1,
            fps=24,
        )
        P.run(cfg, pipe, device, src, f"V2_fluid_{fk}_{pk}")
    del pipe
    gc.collect()
    try:
        import torch

        torch.mps.empty_cache()
    except Exception:
        pass

# 3. masked-gen (inpaint, denoise 1.0, control 0.8) — the missing ones.
mask_jobs = [(fk, pk) for fk in FLU for pk in PK if not canon("mask", fk, pk).exists()]
if mask_jobs:
    from PIL import Image
    import torch

    pipe = M.build_inpaint(P.DEFAULT_MODEL, P.DEFAULT_CONTROLNET)
    for fk, pk in mask_jobs:
        src = P.load_source(FLU[fk], 120)
        gh, gw = src.shape[1], src.shape[2]
        H, W = P.work_dims(gh, gw, 384)
        steps = P.auto_steps(1.0, 0)
        black = Image.fromarray(np.zeros((H, W, 3), np.uint8))
        out = np.empty((120, H, W, 3), np.uint8)
        t0 = time.time()
        for t in range(120):
            dye = cv2.resize(np.asarray(src[t]), (W, H), interpolation=cv2.INTER_LINEAR)
            mask = Image.fromarray((M.density_mask(src[t], W, H) * 255).astype(np.uint8))
            control = P.extract_control(dye, cv2)
            gen = torch.Generator(device="cpu").manual_seed(1)
            out[t] = np.asarray(
                pipe(
                    prompt=PROMPTS[pk],
                    negative_prompt=P.DEFAULT_NEG,
                    image=black,
                    mask_image=mask,
                    control_image=control,
                    height=H,
                    width=W,
                    strength=1.0,
                    num_inference_steps=steps,
                    guidance_scale=0.0,
                    controlnet_conditioning_scale=0.8,
                    generator=gen,
                ).images[0]
            )
        p = canon("mask", fk, pk)
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
        print(f"  [V2_mask_{fk}_{pk}] DONE {(time.time()-t0)/120:.2f}s/f -> {p}", flush=True)

print("MATRIX3 DONE")
