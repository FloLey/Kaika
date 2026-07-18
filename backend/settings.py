"""App-level settings — one JSON file (`data/settings.json`), read late-bound on every
access so a change applies immediately (no restart) and tests can patch `backend.paths`.

Today it holds ONE block: remote inference. The heavy diffusion calls (`imagegen.generate`
/ `stylize_frames` / `depth_frames`) can each be routed to a rented GPU running
`backend/remote_app.py`; `remote_endpoint(op)` is the single gate they all consult.
"""

from __future__ import annotations

import copy
import json
import logging
import threading

from . import paths

log = logging.getLogger("kaika.settings")

_lock = threading.Lock()

# Deep defaults — get_settings() always returns this full shape, with the stored file
# merged on top, so callers and the UI never see missing keys. `ops` names the
# remote-routable operations (one toggle each in the ⚙ settings modal).
DEFAULTS: dict = {
    "inference": {
        "enabled": False,
        "url": "",
        "token": "",
        "ops": {"stylize": True, "imagegen": True, "depth": False},
    },
}


def _merge(base: dict, over: dict) -> dict:
    """Recursive dict merge: `over` wins, unknown keys in `over` are DROPPED (the file
    can't grow junk the app doesn't understand)."""
    out = {}
    for k, v in base.items():
        if isinstance(v, dict):
            out[k] = _merge(v, over.get(k) if isinstance(over.get(k), dict) else {})
        elif k in over and isinstance(over[k], type(v)):
            out[k] = over[k]
        else:
            out[k] = v
    return out


def get_settings() -> dict:
    """The full settings dict (defaults + stored overrides). Never raises: a missing or
    corrupt file just yields the defaults."""
    try:
        stored = json.loads(paths.SETTINGS_FILE.read_text())
    except (OSError, ValueError):
        stored = {}
    return _merge(copy.deepcopy(DEFAULTS), stored if isinstance(stored, dict) else {})


def update_settings(patch: dict) -> dict:
    """Merge `patch` over the current settings, persist, and return the result. Unknown
    keys are dropped by the merge (see _merge) — the caller gets back what stuck."""
    with _lock:
        merged = _merge(get_settings(), patch if isinstance(patch, dict) else {})
        paths.SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        paths.SETTINGS_FILE.write_text(json.dumps(merged, indent=2) + "\n")
    return merged


def remote_endpoint(op: str) -> tuple[str, str] | None:
    """(url, token) when operation `op` should run on the remote GPU, else None.

    Non-None only when remote inference is enabled AND a URL is set AND this op's
    toggle is on. Read fresh on every call — flipping the ⚙ settings mid-session
    redirects the very next generation. `KAIKA_FORCE_LOCAL` (set by remote_app on
    the GPU box) pins everything local so a stray settings.json there can never
    bounce a request back out."""
    import os

    if os.environ.get("KAIKA_FORCE_LOCAL"):
        return None
    inf = get_settings()["inference"]
    if inf["enabled"] and inf["url"].strip() and inf["ops"].get(op):
        return inf["url"].strip().rstrip("/"), inf["token"].strip()
    return None
