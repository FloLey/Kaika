"""Graph executor: a per-segment graph (`01`) -> a rendered, cached, looping mp4.

Resolves every fluid input port to a constant or a signal-driven per-frame array
(native units), builds the `simulate()` params dict, and renders via the
time-varying `fluid.simulate()` (`02`). Exposed at `POST /animate` (`app.py`).

Design notes (locked by the spec):
- Signal definitions ride in the request as `segment.signals` (Issue 1A). The
  executor indexes them by id and never touches the DB.
- Node resolution is memoized and type-dispatched (`resolve_source`) so a future
  `combine` node slots in as just another `nodeId` — no reshaping of the executor.
- The render cache hash folds in the defining fields of every *referenced* signal
  (01 §3.6) so editing a referenced signal busts the cache.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Callable

import numpy as np

from . import fluid, signals
from .animation_params import PARAMS, SOURCE_STATIC_KEYS

# Output (and serving) reuses the existing fluid dir + `/fluid/<name>` route.
ANIM_DIR = Path(__file__).resolve().parent.parent / "data" / "fluid"

FLUID_FPS = 24

# Signal defining-fields folded into the cache hash (01 §3.6). Order is fixed so
# the hashed tuple is stable.
_SIGNAL_HASH_FIELDS = (
    "stemKey", "minHz", "maxHz", "feature", "attack", "release",
    "invert", "gamma", "gain", "offset", "threshold",
)


# --------------------------------------------------------------------------- #
# Validation (01 §3.7)
# --------------------------------------------------------------------------- #
def _nodes_of(graph: dict, ntype: str) -> list[dict]:
    return [n for n in graph.get("nodes", []) if n.get("type") == ntype]


def validate(graph: dict) -> None:
    """Raise ValueError (surfaced as HTTP 400) if the graph is not renderable.

    Rules: exactly one output, exactly one fluid (v1), every node-binding nodeId
    resolves to an existing node, and the binding graph is acyclic.
    """
    if not isinstance(graph, dict):
        raise ValueError("graph must be an object")
    nodes = {n["id"]: n for n in graph.get("nodes", []) if "id" in n}

    outputs = _nodes_of(graph, "output")
    if len(outputs) != 1:
        raise ValueError(f"graph must have exactly one output node (found {len(outputs)})")
    fluids = _nodes_of(graph, "fluid")
    if len(fluids) != 1:
        raise ValueError(f"graph must have exactly one fluid node (found {len(fluids)})")

    # Every node-kind binding must reference an existing node.
    for fl in fluids:
        ports = fl.get("data", {}).get("ports", {})
        for key, port in ports.items():
            binding = (port or {}).get("binding") or {}
            if binding.get("kind") == "node":
                nid = binding.get("nodeId")
                if nid not in nodes:
                    raise ValueError(
                        f"port '{key}' binds to unknown node '{nid}'")

    # Acyclic check over binding edges (value-source -> fluid). v1 graphs are
    # trees; assert acyclic for forward-compat (future combine nodes).
    adj: dict[str, list[str]] = {nid: [] for nid in nodes}
    for fl in fluids:
        for port in fl.get("data", {}).get("ports", {}).values():
            binding = (port or {}).get("binding") or {}
            if binding.get("kind") == "node":
                nid = binding.get("nodeId")
                if nid in nodes:
                    adj[fl["id"]].append(nid)
    if _has_cycle(adj):
        raise ValueError("graph contains a cycle")


def _has_cycle(adj: dict[str, list[str]]) -> bool:
    WHITE, GREY, BLACK = 0, 1, 2
    color = {n: WHITE for n in adj}

    def visit(n: str) -> bool:
        color[n] = GREY
        for m in adj.get(n, ()):
            if color.get(m, BLACK) == GREY:
                return True
            if color.get(m, BLACK) == WHITE and visit(m):
                return True
        color[n] = BLACK
        return False

    return any(color[n] == WHITE and visit(n) for n in adj)


# --------------------------------------------------------------------------- #
# Hashing (01 §3.6)
# --------------------------------------------------------------------------- #
def _node_for_hash(node: dict) -> dict:
    """A node stripped of transient/layout fields (x/y/view) for hashing."""
    data = node.get("data", {})
    return {"id": node.get("id"), "type": node.get("type"), "data": data}


def _referenced_signal_defs(graph: dict, signals_by_id: dict) -> list[list]:
    """For each `signal` node, the ordered defining-field tuple of its signal.

    Only *referenced* signals are hashed (unrelated signal edits must not bust the
    cache). A missing/deleted signal contributes its id + None fields.
    """
    defs = []
    for node in _nodes_of(graph, "signal"):
        sig_id = node.get("data", {}).get("signalId")
        sig = signals_by_id.get(sig_id)
        if sig is None:
            defs.append([sig_id, None])
        else:
            defs.append([sig_id] + [sig.get(f) for f in _SIGNAL_HASH_FIELDS])
    defs.sort(key=lambda d: str(d[0]))
    return defs


def graph_hash(job_id: str, segment: dict, graph: dict, output: dict | None = None) -> str:
    """Stable SHA-1 over the render-defining graph state (01 §3.6).

    Includes nodes (minus x/y/view), edges, segment start/end + job_id, the
    defining fields of every referenced signal, and the project `output` settings
    (size/quality/fps/background). Excludes node positions and view transform so
    moving a node does not invalidate the cache.
    """
    signals_by_id = {s["id"]: s for s in segment.get("signals", []) if "id" in s}
    payload = {
        # Bump when render SEMANTICS change so stale clips (cached under an old
        # meaning of the same graph) are invalidated. v2: clip = full segment
        # (duration is no longer a graph setting) + per-frame medium params + r/g/b.
        "render_version": 2,
        "job_id": job_id,
        "start": float(segment.get("start", 0.0)),
        "end": float(segment.get("end", 0.0)),
        "nodes": [_node_for_hash(n) for n in graph.get("nodes", [])],
        "edges": graph.get("edges", []),
        "signals": _referenced_signal_defs(graph, signals_by_id),
        "output": output or {},
    }
    blob = json.dumps(payload, sort_keys=True, default=str).encode()
    return hashlib.sha1(blob).hexdigest()[:16]


# --------------------------------------------------------------------------- #
# Param building
# --------------------------------------------------------------------------- #
def _source_statics(static: dict) -> dict:
    """The static source-nested params (color, path, toggles) from the fluid card."""
    return {k: static[k] for k in SOURCE_STATIC_KEYS if k in static}


def _signal_curve(node: dict, job_id: str, start: float, end: float, nframes: int,
                  signals_by_id: dict, stem_audio_path: Callable) -> np.ndarray:
    """A signal node -> its 0..1 curve, length nframes, from posted segment.signals.

    Reuses `signals.extract` at the fluid fps so no resample is needed (the safety
    net `fluid._series` snaps to exact length). A missing/deleted signal degrades
    to a flat 0 (01 §3.7) rather than failing the render.
    """
    sig = signals_by_id.get(node.get("data", {}).get("signalId"))
    if sig is None:
        return np.zeros(nframes, np.float32)
    stem_path = stem_audio_path(job_id, sig["stemKey"])
    if stem_path is None:
        return np.zeros(nframes, np.float32)
    d = signals.extract(
        str(stem_path), start, end, sig["minHz"], sig["maxHz"],
        feature=sig.get("feature", "energy"), fps=FLUID_FPS,
        attack=sig.get("attack", 5.0), release=sig.get("release", 250.0),
        invert=sig.get("invert", False), gamma=sig.get("gamma", 1.0),
        gain=sig.get("gain", 1.0), offset=sig.get("offset", 0.0),
        threshold=sig.get("threshold", 0.0),
    )
    curve = np.asarray(d["curve"], np.float32)
    return fluid._series(curve, nframes)


def build_params(job_id: str, segment: dict, graph: dict,
                 stem_audio_path: Callable, output: dict | None = None) -> dict:
    """Resolve `graph` into a `simulate()` params dict (no render).

    Split out from `render` so tests can assert the per-frame arrays without
    encoding an mp4. Each modulatable port becomes a scalar (const binding) or a
    length-nframes native-unit array (node binding mapped lo + (hi-lo)*curve).

    `output` carries the project render settings (size/quality/fps/background);
    when present it drives the grid + fps (the legacy square `grid` is dropped).
    """
    output = output or {}
    nodes = {n["id"]: n for n in graph["nodes"]}
    fluid_node = _nodes_of(graph, "fluid")[0]
    start, end = float(segment["start"]), float(segment["end"])
    signals_by_id = {s["id"]: s for s in segment.get("signals", []) if "id" in s}
    static = fluid_node["data"].get("static", {})
    # The clip is ALWAYS the full segment — duration is not a graph/card setting.
    duration = max(0.5, end - start)
    fps = int(output.get("fps", FLUID_FPS))
    # Per-frame arrays must match simulate()'s frame count, which uses this fps.
    nframes = max(1, round(duration * fps))

    # Memoized, type-dispatched node resolution -> 0..1 curve, length nframes.
    cache: dict[str, np.ndarray] = {}

    def resolve_source(node_id: str) -> np.ndarray:
        if node_id in cache:
            return cache[node_id]
        node = nodes[node_id]
        if node["type"] == "constant":
            v = float(node["data"].get("value", 0.0))
            out = np.full(nframes, v, np.float32)
        elif node["type"] == "signal":
            out = _signal_curve(node, job_id, start, end, nframes,
                                 signals_by_id, stem_audio_path)
        # elif node["type"] == "combine":   # <- future: resolve inputs, mix
        else:
            out = np.zeros(nframes, np.float32)
        cache[node_id] = out
        return out

    ports = fluid_node["data"].get("ports", {})
    src_params: dict = {}
    fluid_params: dict = {}
    for key, (group, pmin, pmax, pdef) in PARAMS.items():
        target = src_params if group == "source" else fluid_params
        binding = (ports.get(key) or {}).get("binding")
        if not binding or binding.get("kind") == "const":
            target[key] = float(binding["value"]) if binding else pdef
        else:  # kind == "node"
            lo = float(binding.get("lo", pmin))
            hi = float(binding.get("hi", pmax))
            curve = resolve_source(binding["nodeId"])         # 0..1, len nframes
            target[key] = (lo + (hi - lo) * curve).tolist()   # native-unit array

    params = {
        "duration": duration,
        "fps": fps,
        "source": {**_source_statics(static), **src_params},
        "fluid": fluid_params,
    }
    if output:
        params["output"] = {
            "width": int(output.get("width", 1080)),
            "height": int(output.get("height", 1920)),
            "quality": output.get("quality", "normal"),
            "fps": fps,
            "background": output.get("background", "#000000"),
        }
    else:
        params["grid"] = int(static.get("grid", 96))   # legacy square fallback
    return params


# --------------------------------------------------------------------------- #
# Render
# --------------------------------------------------------------------------- #
def render(job_id: str, segment: dict, graph: dict,
           stem_audio_path: Callable, output: dict | None = None) -> str:
    """Resolve `graph` for `segment`, render an mp4, return its public URL.

    `stem_audio_path(job_id, stem)` is injected from app.py (its existing helper).
    `output` is the project render settings (size/quality/fps/background). Cached
    by graph+output hash: an identical request returns the existing file's URL.
    Raises ValueError on a bad graph (surfaced as HTTP 400).
    """
    output = output or {}
    validate(graph)
    out_path = ANIM_DIR / f"{graph_hash(job_id, segment, graph, output)}.mp4"
    url = f"/fluid/{out_path.name}"
    if out_path.exists():
        return url

    params = build_params(job_id, segment, graph, stem_audio_path, output)
    frames, fps, _hw = fluid.simulate(params)
    out_w = int(output.get("width", 0)) or None
    out_h = int(output.get("height", 0)) or None
    fluid.render_mp4(frames, fps, out_path, out_w, out_h)
    return url
