#!/usr/bin/env bash
# Bring a rented GPU box up as a Kaika inference server, from a fresh checkout.
#
#   VOL=/workspace KAIKA_REMOTE_TOKEN=<secret> ./scripts/remote_pod.sh
#
# Idempotent: re-running it on a warm pod skips the install and the download and goes
# straight to serving, so it is safe as the pod's start command.
#
# What it gets right that a hand-typed session usually does not:
#   - HF_HOME on the persistent volume. The default cache is on the container's
#     ephemeral disk, so without this you re-download ~40 GB on every restart.
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

# Marker rather than a pip probe: `pip install` on a warm pod still takes ~30s to decide
# it has nothing to do, and this script doubles as a start command.
STAMP="$VOL/.kaika-deps-$(md5sum requirements.txt | cut -c1-8)"
if [ ! -f "$STAMP" ]; then
  echo -e "\n▸ installing dependencies"
  python -m pip install --quiet --upgrade pip
  python -m pip install -r requirements.txt
  touch "$STAMP"
else
  echo -e "\n▸ dependencies already installed (requirements.txt unchanged)"
fi

echo -e "\n▸ checking the GPU"
python - <<'PY'
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
python -m scripts.warm_models ${WARM_ARGS:-}

echo -e "\n▸ serving on :$PORT — supervised, Ctrl-C to stop"
# A CUDA OOM takes the process down; the app would just see a dead port. Restart with a
# pause so a genuinely broken box does not spin.
while true; do
  python -m backend.remote_app || echo "  ✗ server exited ($?) — restarting in 5s"
  sleep 5
done
