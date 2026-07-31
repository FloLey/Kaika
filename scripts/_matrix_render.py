"""One-off driver: render the prompt x fluid matrix with Recipe A, reusing one pipe."""

import sys, types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ai_stylize_prototype as P

DENSE = "d0e3b447c35129f5"
SPARSE = "b64f1a34f1067c83"
PROMPTS = {
    "lava": "molten lava, glowing embers, flowing magma, dark background, cinematic",
    "flowers": "flowers, blooming roses and peonies, lush colorful petals, floral, dark background",
    "lightning": "lightning bolts, electric plasma arcs, glowing energy, dark stormy sky, cinematic",
    "trees": "lush green forest canopy, trees and foliage, branches, misty light, cinematic",
}
# (source_key, prompt_key) still to render (dense lava/flowers already exist)
JOBS = [
    (DENSE, "lightning"),
    (DENSE, "trees"),
    (SPARSE, "lava"),
    (SPARSE, "flowers"),
    (SPARSE, "lightning"),
    (SPARSE, "trees"),
]

pipe, device = P.build_pipe(P.DEFAULT_MODEL, P.DEFAULT_CONTROLNET)
for src_key, pk in JOBS:
    src = P.load_source(src_key, 120)
    cfg = types.SimpleNamespace(
        prompt=PROMPTS[pk],
        neg=P.DEFAULT_NEG,
        res=384,
        denoise=1.0,
        steps=0,
        control_scale=0.8,
        per_frame=True,
        noise_inject=0.0,
        lab=0,
        fixed_noise=True,
        seed=1,
        fps=24,
    )
    tag = f"MTX_{src_key}_{pk}"
    P.run(cfg, pipe, device, src, tag)
print("MATRIX DONE")
