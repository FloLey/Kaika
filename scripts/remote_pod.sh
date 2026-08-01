#!/usr/bin/env bash
# Bring a rented GPU box up as a Kaika inference server, from a fresh checkout.
#
#   VOL=/workspace KAIKA_REMOTE_TOKEN=<secret> ./scripts/remote_pod.sh
#
# Idempotent: re-running it on a warm pod skips the install and the download and goes
# straight to serving, so it is safe as the pod's start command.
#
# What it gets right that a hand-typed session usually does not:
#   - HF_HOME on the persistent volume. It defaults to the container's ephemeral disk,
#     so without this a redeploy re-downloads ~40 GB of weights — and redeploying is
#     the normal way to use a network volume, not an edge case.
#   - Models downloaded BEFORE the port opens, so the app never meets a server that
#     accepts a job and then sits silent for half an hour.
#   - The server supervised, because a CUDA OOM kills the process and a dead port
#     surfaces in the app as "unreachable" rather than as anything diagnosable.
set -euo pipefail

VOL="${VOL:-/workspace}"
export PORT="${PORT:-5100}"
# The HD model and its ControlNet leave a few hundred MiB on a 24 GB card, and the
# allocator's default segments fragment that margin into pieces too small to use — the
# OOM message itself recommends this. Expandable segments grow in place instead, so the
# free memory stays one usable block.
export PYTORCH_CUDA_ALLOC_CONF="${PYTORCH_CUDA_ALLOC_CONF:-expandable_segments:True}"
export HF_HOME="${HF_HOME:-$VOL/hf}"

cd "$(dirname "$0")/.."

echo "=== Kaika remote inference ==="
echo "  repo    $(pwd)"
echo "  HF_HOME $HF_HOME"
echo "  port    $PORT"

if [ ! -d "$VOL" ]; then
  echo "✗ $VOL does not exist — set VOL to the pod's persistent volume." >&2
  echo "  Without one, every restart re-downloads ~40 GB of weights." >&2
  exit 1
fi
mkdir -p "$HF_HOME"

# A public URL with no token is someone else's free GPU. Refuse rather than warn: the
# whole point of this script is that it is run once, quickly, and not read closely.
if [ -z "${KAIKA_REMOTE_TOKEN:-}" ]; then
  if [ "${KAIKA_ALLOW_OPEN:-}" = "1" ]; then
    echo "  ⚠ no token — server is OPEN. Only acceptable behind an SSH tunnel."
  else
    echo "✗ KAIKA_REMOTE_TOKEN is not set." >&2
    echo "  Set one, or pass KAIKA_ALLOW_OPEN=1 if this port is only reachable" >&2
    echo "  through an SSH tunnel." >&2
    exit 1
  fi
fi

# The venv goes on the CONTAINER disk, the weights on the volume. That split is not
# arbitrary — it follows what each filesystem is good at. A rented box's volume is
# typically network-backed (RunPod's is MooseFS): measured on one, ~414 MB/s streaming
# but ~21 ms per file created. Model weights are a handful of multi-GB files read
# sequentially, so they are perfectly happy there. A venv with torch is ~40k small files,
# so the same volume costs a quarter of an hour to install onto and pays that latency
# again on every import, forever. Losing the venv on redeploy and spending ~5 minutes
# rebuilding it is the cheaper side of that trade.
#
# Override with KAIKA_VENV if your volume is local NVMe, where the reverse holds.
#
# Whatever the location, the stamp lives INSIDE the venv. It used to sit on the volume
# while the packages went to the container, so a redeploy kept the marker and lost the
# packages under it — "already installed", then a failure at the first import. The stamp
# also records the interpreter, since a redeploy on a newer base image gets a different
# python and a venv built against the old one stops importing without saying so. And the
# last word still goes to an actual import: a box that claims to be ready and fails on
# the first request is the failure this whole script exists to prevent.
VENV="${KAIKA_VENV:-/opt/kaika-venv}"
PY="$VENV/bin/python"
STAMP="$VENV/.kaika-deps"

# requirements.txt pins scipy 1.18 and numpy 2.4, which publish no wheels below 3.12 —
# and GPU images are routinely a version or two behind (the RunPod PyTorch 2.4 image is
# 3.11). Left to the system python, the install runs for four minutes and then dies on a
# resolver error, which reads like a broken pin rather than a wrong interpreter. Find one
# that qualifies, and fetch one if the box has none: uv ships standalone CPython builds,
# so this needs no PPA and no apt.
PYBASE=""
for c in python3.12 python3.13 python3 python; do
  command -v "$c" >/dev/null 2>&1 || continue
  if "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)' 2>/dev/null; then
    PYBASE="$(command -v "$c")"
    break
  fi
done
if [ -z "$PYBASE" ]; then
  echo -e "\n▸ no python >= 3.12 on this image — fetching one with uv"
  python3 -m pip install --quiet --no-cache-dir uv
  python3 -m uv python install 3.12
  PYBASE="$(python3 -m uv python find 3.12)"
  [ -x "$PYBASE" ] || { echo "✗ could not obtain a python 3.12" >&2; exit 1; }
fi
echo "  python  $PYBASE ($("$PYBASE" -V 2>&1))"

WANT="$(md5sum requirements.txt | cut -c1-8) $("$PYBASE" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"

ok=0
if [ -x "$PY" ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$WANT" ]; then
  "$PY" -c "import torch, diffusers, flask" 2>/dev/null && ok=1
  [ $ok -eq 1 ] || echo "  ⚠ venv stamped but not importable — rebuilding"
fi

if [ $ok -eq 0 ]; then
  free_gb=$(df -BG --output=avail "$(dirname "$VENV")" 2>/dev/null | tail -1 | tr -dc 0-9)
  if [ -n "$free_gb" ] && [ "$free_gb" -lt 14 ]; then
    echo "  ⚠ only ${free_gb} GB free at $VENV — torch and its CUDA libs need ~12 GB."
    echo "    Set KAIKA_VENV to somewhere roomier if the install fails."
  fi
  echo -e "\n▸ installing dependencies into $VENV (a few minutes, once per pod)"
  [ -x "$PY" ] || "$PYBASE" -m venv "$VENV"
  "$PY" -m pip install --quiet --upgrade pip
  # --no-cache-dir: pip's wheel cache is GBs, and a container disk is often 20 GB
  # total. We install once per pod; there is nothing for a cache to speed up.
  "$PY" -m pip install --no-cache-dir -r requirements.txt

  # PyPI serves ONE torch build per version, currently linked against CUDA 13, which
  # needs a 580+ driver. Rented boxes lag: this was measured on a RunPod image whose
  # driver was 12.4, where that wheel imports fine and then reports no CUDA device — a
  # 4090 sitting idle behind a stack that says it cannot see a GPU. PyTorch's own index
  # carries the same VERSION built against CUDA 12, and CUDA minor-version compatibility
  # means a cu126 build runs on any 12.x driver. So match the build to the driver.
  #
  # It has to be requested by its full local version (2.12.1+cu126): plain `torch==2.12.1`
  # is already satisfied by the cu130 wheel, and pip does nothing at all.
  drv_major=$(nvidia-smi 2>/dev/null | sed -n 's/.*CUDA Version: \([0-9]*\).*/\1/p' | head -1)
  if [ -n "$drv_major" ] && [ "$drv_major" -lt 13 ]; then
    tver=$(sed -n 's/^torch==\([0-9.]*\).*/\1/p' requirements.txt | head -1)
    echo "  driver speaks CUDA ${drv_major}.x — refitting torch $tver to a cu126 build"
    "$PY" -m pip install --no-cache-dir --quiet \
      --index-url https://download.pytorch.org/whl/cu126 "torch==${tver}+cu126" \
      || echo "  ⚠ no cu126 build for torch $tver — the GPU check below will say if it matters"

    # torchaudio and torchcodec are C extensions linked against the torch we just
    # replaced, so their .so files stop loading — and transformers imports torchaudio on
    # the way into diffusers, which turns an unused package into a hard failure three
    # layers away ("Failed to import diffusers.loaders.peft"). Absent is fine: every
    # importer of these checks availability first. They arrive here only as demucs
    # dependencies, and stem separation never runs on the inference box.
    "$PY" -m pip uninstall -y -q torchaudio torchcodec 2>/dev/null || true
  fi
  echo "$WANT" > "$STAMP"
else
  echo -e "\n▸ dependencies already installed — skipping"
fi

echo -e "\n▸ checking the GPU"
"$PY" - <<'PY'
import torch
if not torch.cuda.is_available():
    raise SystemExit(
        f"✗ torch {torch.__version__} sees no CUDA device.\n"
        "  A CPU box will 'work' and take hours per clip — stopping instead."
    )
free, total = torch.cuda.mem_get_info()
print(f"  {torch.cuda.get_device_name(0)}  {total / 2**30:.0f} GB  torch {torch.__version__}")
if total / 2**30 < 22:
    print("  ⚠ under 24 GB — the HD model (~16 GB in bf16) will not fit alongside its ControlNet.")
PY

echo -e "\n▸ warming models (downloads only, no VRAM)"
# Unquoted on purpose: quoted, an unset WARM_ARGS becomes an empty argv entry
# and argparse rejects it.
# shellcheck disable=SC2086
"$PY" -m scripts.warm_models ${WARM_ARGS:-}

echo -e "\n▸ serving on :$PORT — supervised, Ctrl-C to stop"
# A CUDA OOM takes the process down; the app would just see a dead port. Restart with a
# pause so a genuinely broken box does not spin.
while true; do
  "$PY" -m backend.remote_app || echo "  ✗ server exited ($?) — restarting in 5s"
  sleep 5
done
