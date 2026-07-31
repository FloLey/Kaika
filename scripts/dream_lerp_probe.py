"""specs/dream step 01 exit gate: does the prompt-embedding crossfade actually work?

The Dream card fades between prompts by lerping their TEXT EMBEDDINGS (one diffusion call
per frame) rather than by dissolving two generated images (two calls). For SD that is the
standard trick on a bidirectional CLIP encoder and it is known to work. For Z-Image it is
an open question: the encoder is causal (attention-masked, `hidden_states[-2]`), and a
position-wise lerp between two different sentences is much less principled there. It will
produce *something*; whether the midpoint is a coherent image or mud is empirical, and
this script is how we find out.

    .venv/bin/python -m scripts.dream_lerp_probe --model draft
    .venv/bin/python -m scripts.dream_lerp_probe --model hd

Writes a contact sheet to data/dream_probe/. Look at it. The verdict goes in
specs/dream/01-inference-core.md.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

from backend import imagegen

OUT_DIR = Path(__file__).resolve().parent.parent / "data" / "dream_probe"
WEIGHTS = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]


def control_frame(size: int = 512) -> np.ndarray:
    """A synthetic canny-ish control map: a horizon, a disc and two verticals. Sparse
    enough to be a fair test — a dense control would carry the image on its own and hide
    whether the prompt conditioning is doing anything."""
    import cv2

    img = np.zeros((size, size, 3), np.uint8)
    cv2.line(img, (0, int(size * 0.62)), (size, int(size * 0.62)), (255, 255, 255), 2)
    cv2.circle(img, (size // 2, int(size * 0.40)), size // 6, (255, 255, 255), 2)
    cv2.line(img, (int(size * 0.18), size), (int(size * 0.26), int(size * 0.62)), (255,) * 3, 2)
    cv2.line(img, (int(size * 0.82), size), (int(size * 0.74), int(size * 0.62)), (255,) * 3, 2)
    return img


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", choices=("draft", "hd"), default="draft")
    ap.add_argument("--prompt-a", default="a snowy mountain range at dawn, photograph")
    ap.add_argument("--prompt-b", default="a molten lava field at night, photograph")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--short", type=int, default=None)
    ap.add_argument(
        "--weights",
        default=None,
        help="comma-separated blend weights (default 0.0..1.0 by 0.1). Use a narrow range "
        "to characterise a steep transition: --weights 0.40,0.45,0.50,0.55,0.60",
    )
    ap.add_argument("--tag", default="", help="suffix for the output filename")
    args = ap.parse_args()

    global WEIGHTS
    if args.weights:
        WEIGHTS = [float(x) for x in args.weights.split(",")]

    model = imagegen.HD_MODEL if args.model == "hd" else imagegen.DRAFT_MODEL
    control = np.stack([control_frame()] * len(WEIGHTS))
    plan = [
        {
            "prompt_a": args.prompt_a,
            "prompt_b": args.prompt_b,
            "w": w,
            "seed": args.seed,
            "scale": 0.7,
        }
        for w in WEIGHTS
    ]

    print(f"model={model}  frames={len(plan)}  seed={args.seed}")
    print(f"  A: {args.prompt_a}")
    print(f"  B: {args.prompt_b}")
    frames = imagegen.dream_frames(
        control,
        plan,
        model=model,
        short=args.short,
        on_progress=lambda d, t: print(f"  frame {d}/{t}", flush=True),
    )

    # Endpoint parity: w=0 must equal a plain single-prompt render of A, and w=1 of B.
    # This is the property the fade feature rests on — a hold frame has to be identical to
    # what a render with no fades at all would produce.
    ends = imagegen.dream_frames(
        control[:2],
        [
            {
                "prompt_a": args.prompt_a,
                "prompt_b": None,
                "w": 0.0,
                "seed": args.seed,
                "scale": 0.7,
            },
            {
                "prompt_a": args.prompt_b,
                "prompt_b": None,
                "w": 0.0,
                "seed": args.seed,
                "scale": 0.7,
            },
        ],
        model=model,
        short=args.short,
    )
    a_ok = np.array_equal(frames[0], ends[0])
    b_ok = np.array_equal(frames[-1], ends[1])
    print(
        f"endpoint parity: w=0 vs plain-A {'OK' if a_ok else 'MISMATCH'}, "
        f"w=1 vs plain-B {'OK' if b_ok else 'MISMATCH'}"
    )

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    import cv2

    h, w = frames.shape[1:3]
    sheet = np.zeros((h, w * len(frames), 3), np.uint8)
    for i, f in enumerate(frames):
        sheet[:, i * w : (i + 1) * w] = f
        cv2.putText(
            sheet,
            f"{WEIGHTS[i]:.1f}",
            (i * w + 8, 28),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.8,
            (0, 255, 0),
            2,
        )
    path = OUT_DIR / f"lerp-{args.model}-seed{args.seed}{args.tag}.png"
    cv2.imwrite(str(path), cv2.cvtColor(sheet, cv2.COLOR_RGB2BGR))
    cv2.imwrite(str(OUT_DIR / "control.png"), control_frame())
    print(f"wrote {path}")
    return 0 if (a_ok and b_ok) else 1


if __name__ == "__main__":
    raise SystemExit(main())
