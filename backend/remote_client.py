"""Client side of remote inference: POST diffusion work to a rented GPU running
`backend/remote_app.py`, and hand back exactly what the local imagegen functions
would have returned.

Transport is npz (np.savez_compressed) for frame arrays — one self-describing body,
no base64 blowup. Stylize ships in BATCHES of frames: the job's `frame X/Y` progress
advances per batch, a network hiccup retries one bounded payload instead of the whole
clip, and (each frame being independently seeded with the SAME seed) the batching
cannot change the output. Any failure raises RuntimeError("remote inference …") — the
job surfaces it on the card; there is deliberately NO silent local fallback (a
misconfigured box should never turn into a surprise 40-minute local run).
"""

from __future__ import annotations

import io
import json
import logging

log = logging.getLogger("kaika.remote")

STYLIZE_BATCH = 8  # frames per POST — ~15 MB of HD output per batch, minutes of GPU work
TIMEOUT = 900  # seconds per request; a batch of 8 HD frames is minutes even on CUDA


def pack_npz(**arrays) -> bytes:
    """np arrays → one compressed npz body (shared with remote_app)."""
    import numpy as np

    buf = io.BytesIO()
    np.savez_compressed(buf, **arrays)
    return buf.getvalue()


def unpack_npz(data: bytes) -> dict:
    """npz body → {name: array} (shared with remote_app)."""
    import numpy as np

    return dict(np.load(io.BytesIO(data)))


def _post(url: str, token: str, path: str, body: bytes, params: dict, what: str):
    """One POST with the npz body + JSON params header. Retries once (fresh
    connection) — beyond that the caller's clip is better failed than half-baked."""
    import requests

    headers = {
        "Content-Type": "application/x-npz",
        "X-Kaika-Params": json.dumps(params),
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    last = None
    for attempt in (1, 2):
        try:
            r = requests.post(f"{url}{path}", data=body, headers=headers, timeout=TIMEOUT)
            if r.status_code == 200:
                return r.content
            # An HTTP error is the server talking — don't retry 4xx (same request,
            # same answer); do retry a 5xx once (transient worker hiccup).
            detail = r.text[:300]
            last = f"HTTP {r.status_code}: {detail}"
            if r.status_code < 500:
                break
        except requests.RequestException as e:  # noqa: PERF203 — two attempts only
            last = str(e)
        log.warning("remote %s attempt %d failed: %s", what, attempt, last)
    raise RuntimeError(f"remote inference ({url}): {what} failed — {last}")


def stylize_remote(
    frames,
    prompt,
    strength,
    inpaint,
    model,
    seed,
    control,
    control_scale,
    negative,
    short,
    url,
    token,
    on_progress=None,
):
    """Remote twin of imagegen.stylize_frames — same signature semantics, batched.
    All defaults are already resolved by the caller; the server applies them verbatim."""
    import numpy as np

    params = dict(
        prompt=str(prompt),
        strength=float(strength),
        inpaint=bool(inpaint),
        model=model,
        seed=int(seed),
        control_scale=float(control_scale),
        negative=str(negative),
        short=int(short),
    )
    total = len(frames)
    chunks = []
    for i in range(0, total, STYLIZE_BATCH):
        arrays = {"frames": np.ascontiguousarray(frames[i : i + STYLIZE_BATCH])}
        if control is not None and len(control) > 0:
            # index-aligned slice; a shorter control clip holds its last frame,
            # mirroring the local path's `min(i, len(control)-1)`.
            idx = np.minimum(np.arange(i, min(i + STYLIZE_BATCH, total)), len(control) - 1)
            arrays["control"] = np.ascontiguousarray(np.asarray(control)[idx])
        out = _post(url, token, "/stylize", pack_npz(**arrays), params, "stylize")
        styled = unpack_npz(out).get("styled")
        if styled is None:
            raise RuntimeError(f"remote inference ({url}): stylize returned no frames")
        chunks.append(styled)
        if on_progress is not None:
            on_progress(min(i + STYLIZE_BATCH, total), total)
    return np.concatenate(chunks, axis=0)


def dream_remote(control, plan, model, short, url, token, init=None, on_progress=None):
    """Remote twin of imagegen.dream_frames — batched like `stylize_remote`.

    The PLAN travels as JSON in the params header, sliced per batch so each request
    carries exactly the entries for the control frames it ships. The frame CACHE stays
    on the client (imagegen.dream_frames consults it before this call and fills it
    after), so a remote run still leaves a warm local cache. `init` is the optional
    per-frame start clip — index-aligned with `control`, sliced the same way."""
    import json

    import numpy as np

    total = len(plan)
    chunks = []
    for i in range(0, total, STYLIZE_BATCH):
        hi = min(i + STYLIZE_BATCH, total)
        # index-aligned slice; a shorter control clip holds its last frame, mirroring
        # the local path's `min(i, len(control)-1)`.
        idx = np.minimum(np.arange(i, hi), len(control) - 1)
        arrays = {"control": np.ascontiguousarray(np.asarray(control)[idx])}
        if init is not None and len(init) > 0:
            arrays["init"] = np.ascontiguousarray(np.asarray(init)[idx])
        params = dict(model=model, short=int(short), plan=json.dumps(plan[i:hi]))
        out = _post(url, token, "/dream", pack_npz(**arrays), params, "dream")
        frames = unpack_npz(out).get("frames")
        if frames is None:
            raise RuntimeError(f"remote inference ({url}): dream returned no frames")
        chunks.append(frames)
        if on_progress is not None:
            on_progress(hi, total)
    return np.concatenate(chunks, axis=0)


def generate_remote(prompt, seed, count, model, long_edge, aspect, url, token) -> list:
    """Remote twin of imagegen.generate → list of PIL images."""
    from PIL import Image

    params = dict(
        prompt=str(prompt),
        seed=int(seed),
        count=int(count),
        model=model,
        long_edge=long_edge,
        aspect=list(aspect) if aspect else None,
    )
    out = _post(url, token, "/generate", b"", params, "generate")
    arrays = unpack_npz(out)
    return [Image.fromarray(arrays[k]) for k in sorted(arrays)]


def depth_remote(frames, url, token):
    """Remote twin of imagegen.depth_frames."""
    out = _post(url, token, "/depth", pack_npz(frames=frames), {}, "depth")
    depth = unpack_npz(out).get("depth")
    if depth is None:
        raise RuntimeError(f"remote inference ({url}): depth returned no frames")
    return depth
