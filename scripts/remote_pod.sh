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
WANT="$(md5sum requirements.txt | cut -c1-8) $(python -c 'import sys; print("%d.%d" % sys.version_info[:2])')"

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
  [ -x "$PY" ] || python -m venv "$VENV"
  "$PY" -m pip install --quiet --upgrade pip
  # --no-cache-dir: pip's wheel cache is GBs, and a container disk is often 20 GB
  # total. We install once per pod; there is nothing for a cache to speed up.
  "$PY" -m pip install --no-cache-dir -r requirements.txt
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
