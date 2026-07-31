"""Pre-download every model `backend/remote_app.py` can be asked for.

The remote server fetches from Hugging Face on the FIRST request per model, so a cold
pod answers its first real job after a ~40 GB download — long enough that the card
looks hung and the app's own timeouts start to matter. Run this once after the pod
comes up, while nothing is waiting on it.

This DOWNLOADS, it does not load: `snapshot_download` never touches the GPU, so
warming every model costs disk and no VRAM. Loading them all instead would try to hold
four pipelines resident at once, which is exactly the OOM this script exists to avoid.

    HF_HOME=/workspace/hf python -m scripts.warm_models          # everything
    HF_HOME=/workspace/hf python -m scripts.warm_models --hd     # just the HD pair
    HF_HOME=/workspace/hf python -m scripts.warm_models --smoke  # + one real generation

`--smoke` is the only part that proves the GPU works rather than just the disk. It runs
one tiny draft generation through the same `imagegen.generate` the server calls, so a
broken CUDA/torch pairing fails here, on your terminal, instead of on a card mid-export.
"""

from __future__ import annotations

import argparse
import os
import sys
import time

# Same pin remote_app uses: this process must never bounce a request back out to
# another server because a settings.json happened to be lying around.
os.environ["KAIKA_FORCE_LOCAL"] = "1"

from backend import imagegen  # noqa: E402


def _repos(hd_only: bool) -> list[tuple[str, str]]:
    """(repo_id, what it is) for everything the server can be asked to load."""
    hd = [
        (imagegen.HD_MODEL, "HD generator (Z-Image-Turbo)"),
        (imagegen.STYLIZE_CONTROLNET[imagegen.HD_MODEL], "HD ControlNet (Union)"),
    ]
    if hd_only:
        return hd
    return hd + [
        (imagegen.DRAFT_MODEL, "draft generator (SD-Turbo)"),
        (imagegen.STYLIZE_CONTROLNET[imagegen.DRAFT_MODEL], "draft ControlNet (canny)"),
        (imagegen.DEPTH_MODEL, "depth estimator"),
    ]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--hd", action="store_true", help="only the HD model + its ControlNet")
    ap.add_argument("--smoke", action="store_true", help="also run one real generation")
    args = ap.parse_args()

    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        print("huggingface_hub missing — run `pip install -r requirements.txt` first", flush=True)
        return 1

    print(f"HF_HOME={os.environ.get('HF_HOME', '(default ~/.cache/huggingface)')}", flush=True)
    if not os.environ.get("HF_HOME"):
        # Worth a shout: the default cache sits on the container's ephemeral disk, so
        # every pod restart re-downloads the lot. This is the single most expensive
        # thing to get wrong about a rented box.
        print("  ⚠ not on a persistent volume — this download will not survive a restart")

    failed = []
    for repo, what in _repos(args.hd):
        t0 = time.time()
        print(f"\n▸ {what}\n  {repo}", flush=True)
        try:
            snapshot_download(repo)
            print(f"  ✓ {time.time() - t0:.0f}s", flush=True)
        except Exception as e:  # noqa: BLE001 — report every failure, don't stop at the first
            print(f"  ✗ {e}", flush=True)
            failed.append(repo)

    if args.smoke and not failed:
        print("\n▸ smoke test — one draft generation on the GPU", flush=True)
        t0 = time.time()
        try:
            imgs = imagegen.generate("a test pattern", model=imagegen.DRAFT_MODEL, long_edge=256)
            print(f"  ✓ {imgs[0].size} in {time.time() - t0:.0f}s on {imagegen._pick_device()}")
        except Exception as e:  # noqa: BLE001
            print(f"  ✗ {e}", flush=True)
            failed.append("smoke test")

    if failed:
        print(f"\n{len(failed)} failed: {', '.join(failed)}", flush=True)
        return 1
    print("\nall warm — start the server with `python -m backend.remote_app`", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
