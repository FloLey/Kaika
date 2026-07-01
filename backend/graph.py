"""Graph executor: a per-segment graph (`01`) -> a rendered, cached, looping mp4.

Resolves every fluid input port to a constant value (an un-wired port's slider) or
a signal-driven per-frame array (native units), builds the `simulate()` params
dict, and renders via the time-varying `fluid.simulate()` (`02`). Exposed at
`POST /animate` (`app.py`).

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
import logging
import os
import shutil
import subprocess
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable

import numpy as np

from . import fluid, fluid_cache, render_cache, signals, sources
from .animation_params import COLOR_PARAMS, OUTPUT_DEFAULTS, PARAMS, SOURCE_STATIC_KEYS

# Modulatable-port specs for the non-fluid ported cards (FX + sources + the color
# card): key -> (min, max, default). The single backend lookup for resolving their
# ports / validating their bindings. The `color` card feeds the fluid's dye colour
# (resolved in build_params), so it never renders a video — but its ports validate here.
_PORT_SPECS = {**sources.SOURCE_PARAMS, "color": COLOR_PARAMS}

log = logging.getLogger("kaika.graph")

# Output (and serving) reuses the existing fluid dir + `/fluid/<name>` route.
ANIM_DIR = Path(__file__).resolve().parent.parent / "data" / "fluid"

FLUID_FPS = 24

# Streaming renders emit the clip in front-to-back blocks of this many seconds, so a
# long segment previews in ~one block's time instead of after the whole render. The
# blocks concatenate losslessly into the same final mp4 the sync path produces.
RENDER_BLOCK_SECONDS = float(os.environ.get("RENDER_BLOCK_SECONDS", "5"))
# Streaming scratch (per-render chunks + growing preview) lives under the fluid dir
# so it's served by `/fluid/stream/<render_id>/<name>`; not part of the LRU cache.
STREAM_DIR = ANIM_DIR / "stream"

# Bump when render SEMANTICS change so stale clips (cached under an old meaning of
# the same graph) are invalidated. Folded into `output_hash`.
#   v2: clip = full segment (duration dropped) + per-frame medium params + r/g/b.
#   v3: combine nodes + video DAG + background applied at the terminal (was per-sim).
RENDER_VERSION = 3

# Legacy square-grid fallback (cells per side) for pre-output-settings saves that
# carry no project `output`. The live path derives a rectangular grid from the
# output size (see `fluid.grid_from_output`).
LEGACY_GRID = 96

# Signal defining-fields folded into the cache hash (01 §3.6). Order is fixed so
# the hashed tuple is stable.
_SIGNAL_HASH_FIELDS = (
    "stemKey",
    "minHz",
    "maxHz",
    "feature",
    "attack",
    "release",
    "invert",
    "gamma",
    "gain",
    "offset",
    "threshold",
)

# Node types that produce a video stream are DERIVED from the video-handler registry
# (`_VIDEO_PRODUCERS = tuple(_VIDEO_HANDLERS)`, defined with the handlers below) so a
# new producing node type registers in one place. `output` passes its input through,
# so it's a producer too.
# A merge combine has no fluid card, so its medium params fall back to the canonical
# `fluid`-group defaults (the single source of truth in animation_params.PARAMS).
_MERGE_MEDIUM_DEFAULTS = tuple(
    (k, default) for k, (group, _lo, _hi, default) in PARAMS.items() if group == "fluid"
)


def _output_params(output: dict, fps: int) -> dict:
    """The simulate() top-level `output` block from project render settings.

    Shared by `build_params` (single-fluid) and `_Dag._merge_params` (merge combine)
    so the size/quality/fps/background contract lives in one place."""
    return {
        "width": int(output.get("width", OUTPUT_DEFAULTS["width"])),
        "height": int(output.get("height", OUTPUT_DEFAULTS["height"])),
        "quality": output.get("quality", OUTPUT_DEFAULTS["quality"]),
        "fps": fps,
        "background": output.get("background", OUTPUT_DEFAULTS["background"]),
    }


def _video_source(graph: dict, target_id: str, target_port: str):
    """The node id wired into (target_id, target_port) via an edge, or None."""
    for e in graph.get("edges", []):
        if e.get("target") == target_id and e.get("targetPort") == target_port:
            return e.get("source")
    return None


def _is_emitter_source(graph: dict, node_id, nodes: dict, seen=None) -> bool:
    """Whether `node_id` resolves to fluid emitter(s) for a MERGE — i.e. no layered
    (stack) combine sits upstream (a composited video has no single emitter set)."""
    seen = seen if seen is not None else set()
    if node_id in seen:
        return False
    seen.add(node_id)
    node = nodes.get(node_id)
    if node is None:
        return False
    t = node.get("type")
    if t == "fluid":
        return True
    if t == "output":
        src = _video_source(graph, node_id, "video")
        return src is not None and _is_emitter_source(graph, src, nodes, seen)
    if t == "combine":
        if node.get("data", {}).get("mode") == "stack":
            return False
        for slot in node.get("data", {}).get("inputs", []):
            src = _video_source(graph, node_id, slot.get("id"))
            if src is not None and not _is_emitter_source(graph, src, nodes, seen):
                return False
        return True
    return False


def composite(layers: list, opacities: list) -> np.ndarray:
    """Alpha-over stack of dye-on-transparent uint8 frame stacks (spec 10).

    `layers[0]` is the TOP layer. A layer's coverage (alpha) is its per-pixel
    brightness (max channel) times its `opacity`, so a bright upper layer hides
    what's beneath while dim/empty areas let lower layers show through. The result
    stays dye-on-transparent (the terminal output applies the background)."""
    acc = np.zeros_like(layers[0], dtype=np.float32)
    for layer, op in reversed(list(zip(layers, opacities))):  # bottom -> top
        f = layer.astype(np.float32) / 255.0
        op = float(op)
        a = np.clip(f.max(axis=-1, keepdims=True), 0.0, 1.0) * op
        acc = f * op + acc * (1.0 - a)
    return (np.clip(acc, 0.0, 1.0) * 255).astype(np.uint8)


# --------------------------------------------------------------------------- #
# Validation (01 §3.7)
# --------------------------------------------------------------------------- #
def _nodes_of(graph: dict, ntype: str) -> list[dict]:
    return [n for n in graph.get("nodes", []) if n.get("type") == ntype]


def _fluid_for_output(graph: dict, output_id: str) -> dict:
    """The fluid node feeding `output_id` via its single incoming video edge.

    An output node has only the one `video` in-port, so every edge targeting it is
    that video edge. Raise ValueError if there isn't exactly one, or its source is
    not a fluid node.
    """
    nodes = {n["id"]: n for n in graph.get("nodes", []) if "id" in n}
    incoming = [e for e in graph.get("edges", []) if e.get("target") == output_id]
    if len(incoming) != 1:
        raise ValueError(
            f"output '{output_id}' must be wired to exactly one fluid "
            f"(found {len(incoming)} incoming edges)"
        )
    src = nodes.get(incoming[0].get("source"))
    if src is None or src.get("type") != "fluid":
        raise ValueError(f"output '{output_id}' is not wired to a fluid node")
    return src


def _validate_binding(key: str, binding: dict, nodes: dict) -> None:
    """A fluid port binding must be well-formed: a `const` carries a numeric value; a
    `node` binding references an existing node with numeric lo/hi. A port with no
    binding is allowed (build_params falls back to the param default). Raises
    ValueError so a malformed graph fails at the boundary, not deep in build_params."""
    kind = binding.get("kind")
    if kind == "const":
        if not isinstance(binding.get("value"), (int, float)):
            raise ValueError(f"port '{key}' const binding has a non-numeric value")
    elif kind == "node":
        nid = binding.get("nodeId")
        if nid not in nodes:
            raise ValueError(f"port '{key}' binds to unknown node '{nid}'")
        for b in ("lo", "hi"):
            if b in binding and not isinstance(binding[b], (int, float)):
                raise ValueError(f"port '{key}' node binding has a non-numeric {b}")
    elif kind is not None:
        raise ValueError(f"port '{key}' has an unknown binding kind '{kind}'")


def validate(graph: dict) -> None:
    """Raise ValueError (surfaced as HTTP 400) if the graph is not renderable.

    Rules: at least one output, each output wired to exactly one fluid, every fluid
    port binding well-formed (const numeric / node resolves to an existing node),
    combine slots carry ids, and the binding graph is acyclic. N independent
    fluid->output pipelines are allowed.
    """
    if not isinstance(graph, dict):
        raise ValueError("graph must be an object")
    nodes = {n["id"]: n for n in graph.get("nodes", []) if "id" in n}

    outputs = _nodes_of(graph, "output")
    if len(outputs) < 1:
        raise ValueError("graph must have at least one output node")
    # Each output must be wired to exactly one video producer (fluid / combine /
    # output-passthrough) via its single `video` in-port.
    for out in outputs:
        incoming = [
            e
            for e in graph.get("edges", [])
            if e.get("target") == out["id"] and e.get("targetPort") == "video"
        ]
        if len(incoming) != 1:
            raise ValueError(
                f"output '{out['id']}' must be wired to exactly one source "
                f"(found {len(incoming)})"
            )
        src = nodes.get(incoming[0].get("source"))
        if src is None or src.get("type") not in _VIDEO_PRODUCERS:
            raise ValueError(
                f"output '{out['id']}' must be wired to a video producer "
                f"(fluid / combine / an FX or source card)"
            )

    # Every modulatable port binding must be well-formed (fluid + FX + source cards).
    for node in graph.get("nodes", []):
        if node.get("type") == "fluid" or node.get("type") in _PORT_SPECS:
            for key, port in node.get("data", {}).get("ports", {}).items():
                _validate_binding(key, (port or {}).get("binding") or {}, nodes)

    # Every combine input slot must carry an id (the targetPort a video edge wires to).
    for cb in _nodes_of(graph, "combine"):
        for slot in cb.get("data", {}).get("inputs", []):
            if not slot.get("id"):
                raise ValueError(f"combine '{cb['id']}' has an input slot with no id")

    # A merge combine's inputs must resolve to fluid emitters — a composited video
    # (a layered combine, or a video source like lyrics) has no single emitter set.
    for cb in _nodes_of(graph, "combine"):
        if cb.get("data", {}).get("mode") == "merge":
            for slot in cb.get("data", {}).get("inputs", []):
                src = _video_source(graph, cb["id"], slot.get("id"))
                if src is not None and not _is_emitter_source(graph, src, nodes):
                    bad = nodes.get(src, {}).get("type", "?")
                    raise ValueError(
                        f"a merge combine only accepts fluid sources, but a '{bad}' card is "
                        f"wired into it — switch the combine to 'layered' to overlay it"
                    )

    # Acyclic over ALL edges (value bindings + video edges).
    adj: dict[str, list[str]] = {nid: [] for nid in nodes}
    for e in graph.get("edges", []):
        if e.get("target") in adj and e.get("source") in nodes:
            adj[e["target"]].append(e["source"])
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


def _contributing_ids(graph: dict, output_id: str) -> set:
    """Every node id upstream of `output_id` — a backward walk over ALL edges
    (video DAG + value bindings). The output's whole pipeline; disconnected nodes
    and OTHER outputs' pipelines are excluded, so each output caches independently."""
    incoming: dict = {}
    for e in graph.get("edges", []):
        incoming.setdefault(e.get("target"), []).append(e.get("source"))
    seen = set()
    stack = [output_id]
    while stack:
        nid = stack.pop()
        if nid in seen:
            continue
        seen.add(nid)
        stack.extend(incoming.get(nid, ()))
    return seen


def output_hash(
    job_id: str, segment: dict, graph: dict, output_id: str, output: dict | None = None
) -> str:
    """Stable SHA-1 over ONE output's CONTRIBUTING video DAG (spec 10).

    Covers every node upstream of `output_id` (fluids, combines, output
    pass-throughs, value/signal nodes), the edges among them, their referenced
    signal defs, the segment bounds + job id, and the project `output` settings —
    so each output caches independently and editing one pipeline never busts
    another's. Excludes node positions/view.
    """
    contributing = _contributing_ids(graph, output_id)
    nodes = {n["id"]: n for n in graph.get("nodes", []) if "id" in n}
    sub_nodes = [nodes[i] for i in sorted(contributing) if i in nodes]
    signals_by_id = {s["id"]: s for s in segment.get("signals", []) if "id" in s}
    payload = {
        "render_version": RENDER_VERSION,
        "job_id": job_id,
        "output_id": output_id,
        "start": float(segment.get("start", 0.0)),
        "end": float(segment.get("end", 0.0)),
        "nodes": [_node_for_hash(n) for n in sub_nodes],
        "edges": [
            e
            for e in graph.get("edges", [])
            if e.get("source") in contributing and e.get("target") in contributing
        ],
        "signals": _referenced_signal_defs(
            {"nodes": [n for n in sub_nodes if n.get("type") == "signal"]}, signals_by_id
        ),
        "output": output or {},
    }
    # A lyrics card burns external (segment) lyric text into the frames; fold the lines
    # overlapping this segment into the hash so editing the lyrics busts the cache.
    if any(n.get("type") == "lyrics" for n in sub_nodes):
        s, e = float(segment.get("start", 0.0)), float(segment.get("end", 0.0))
        payload["lyrics"] = [
            [round(float(ln.get("t0", 0)), 2), round(float(ln.get("t1", 0)), 2), ln.get("text", "")]
            for ln in (segment.get("lyric_lines") or [])
            if float(ln.get("t1", 0)) > s and float(ln.get("t0", 0)) < e
        ]
    blob = json.dumps(payload, sort_keys=True, default=str).encode()
    return hashlib.sha1(blob).hexdigest()[:16]


# --------------------------------------------------------------------------- #
# Param building
# --------------------------------------------------------------------------- #
def _source_statics(static: dict) -> dict:
    """The static source-nested params (color, path, toggles) from the fluid card."""
    return {k: static[k] for k in SOURCE_STATIC_KEYS if k in static}


def _sample_gradient(stops: list, pos):
    """Sample colour `stops` ([{t, color hex}]) at `pos` (0..1 scalar or array) -> per-
    channel r/g/b (matching pos's shape). Linear between stops, clamped at the ends."""
    if not stops:
        return 0.0, 0.0, 0.0
    s = sorted(stops, key=lambda x: float(x.get("t", 0.0)))
    ts = np.array([float(x.get("t", 0.0)) for x in s], np.float32)
    cols = np.array([fluid._hex_rgb(x.get("color", "#000000")) for x in s], np.float32)
    p = np.clip(pos, 0.0, 1.0)
    return (np.interp(p, ts, cols[:, 0]), np.interp(p, ts, cols[:, 1]), np.interp(p, ts, cols[:, 2]))


def _resolve_fluid_color(graph: dict, fluid_node: dict, nodes: dict, resolve_source) -> dict:
    """The dye colour params (r/g/b/intensity/opacity) for a fluid, read from a `color`
    card wired into its `color` input. Each port is a scalar (const) or per-frame array
    (node binding), exactly like a fluid param. The card has three modes: `swatch` / `rgb`
    read r/g/b directly; `gradient` samples its colour stops at the modulatable `position`.
    Returns ``{}`` when nothing is wired, so simulate() falls back to the fluid's static
    `color` vector. These nest under `source.*` and override the static `color` vector."""
    cid = _video_source(graph, fluid_node["id"], "color")
    color_node = nodes.get(cid) if cid else None
    if color_node is None or color_node.get("type") != "color":
        return {}
    data = color_node.get("data", {})
    ports = data.get("ports", {})

    def port_val(key):
        pmin, pmax, pdef = COLOR_PARAMS[key]
        b = (ports.get(key) or {}).get("binding")
        if not b or b.get("kind") == "const":
            return float(b["value"]) if b else pdef
        lo, hi = float(b.get("lo", pmin)), float(b.get("hi", pmax))
        return lo + (hi - lo) * resolve_source(b["nodeId"])  # 0..1 curve -> native array

    out = {"intensity": port_val("intensity"), "opacity": port_val("opacity")}
    if data.get("mode") == "gradient":
        out["r"], out["g"], out["b"] = _sample_gradient(data.get("stops", []), port_val("position"))
    else:  # swatch / rgb: per-channel ports
        out["r"], out["g"], out["b"] = port_val("r"), port_val("g"), port_val("b")
    # numpy arrays -> lists for the simulate() params dict; scalars pass through.
    return {k: (v.tolist() if hasattr(v, "tolist") else v) for k, v in out.items()}


def _signal_curve(
    node: dict,
    job_id: str,
    start: float,
    end: float,
    nframes: int,
    signals_by_id: dict,
    stem_audio_path: Callable,
) -> np.ndarray:
    """A signal node -> its 0..1 curve, length nframes, from posted segment.signals.

    Reuses `signals.extract` at the fluid fps so no resample is needed (the safety
    net `fluid._series` snaps to exact length). A missing/deleted signal degrades
    to a flat 0 (01 §3.7) rather than failing the render.
    """
    sig = signals_by_id.get(node.get("data", {}).get("signalId"))
    if sig is None:
        return np.zeros(nframes, np.float32)  # deleted signal — silent (01 §3.7)
    stem_path = stem_audio_path(job_id, sig["stemKey"])
    if stem_path is None:
        # The signal exists but its stem doesn't resolve (renamed/missing stem) —
        # a real misconfiguration, not a deleted signal. Degrade to flat 0 so the
        # render still completes, but log it rather than failing silently.
        log.warning(
            "signal '%s' references unresolved stem '%s' (job %s) — using flat 0",
            sig.get("id"),
            sig.get("stemKey"),
            job_id,
        )
        return np.zeros(nframes, np.float32)
    d = signals.extract(
        str(stem_path),
        start,
        end,
        sig["minHz"],
        sig["maxHz"],
        feature=sig.get("feature", "energy"),
        fps=FLUID_FPS,
        attack=sig.get("attack", 5.0),
        release=sig.get("release", 250.0),
        invert=sig.get("invert", False),
        gamma=sig.get("gamma", 1.0),
        gain=sig.get("gain", 1.0),
        offset=sig.get("offset", 0.0),
        threshold=sig.get("threshold", 0.0),
    )
    curve = np.asarray(d["curve"], np.float32)
    return fluid._series(curve, nframes)


def _lfo_curve(data: dict, nframes: int, fps: int) -> np.ndarray:
    """An LFO node -> its 0..1 waveform, length nframes. Tempo-free: the rate is in
    cycles-per-clip or Hz, so the curve is deterministic (no audio decode)."""
    shape = data.get("shape", "sine")
    phase = float(data.get("phase", 0.0))
    duty = float(data.get("duty", 0.5))
    rate = float(data.get("rate", 4.0))
    duration = max(1, nframes) / float(fps or 1)
    cycles = rate * duration if data.get("rateMode") == "hz" else rate
    t = np.linspace(0.0, 1.0, nframes, endpoint=False, dtype=np.float32)
    ph = np.mod(t * cycles + phase, 1.0)
    if shape == "triangle":
        y = np.where(ph < 0.5, ph * 2.0, 2.0 - ph * 2.0)
    elif shape == "saw":
        y = ph
    elif shape == "square":
        y = np.where(ph < duty, 1.0, 0.0)
    else:  # sine
        y = 0.5 + 0.5 * np.sin(ph * 2.0 * np.pi)
    return np.clip(y.astype(np.float32), 0.0, 1.0)


def _noise_curve(data: dict, nframes: int, fps: int) -> np.ndarray:
    """A noise node -> smooth fractal value-noise, length nframes. Seeded only from
    `seed` (never wall-clock) so the render cache stays stable."""
    seed = int(data.get("seed", 1))
    octaves = int(max(1, min(4, round(float(data.get("octaves", 2))))))
    rate = float(data.get("rate", 1.0))
    duration = max(1, nframes) / float(fps or 1)
    acc = np.zeros(nframes, np.float32)
    amp, norm = 1.0, 0.0
    for o in range(octaves):
        pts = max(2, int(round(rate * duration * (2**o))) + 1)
        ctrl = np.random.default_rng(seed + o * 1013).random(pts).astype(np.float32)
        xs = np.linspace(0.0, pts - 1, nframes, dtype=np.float32)
        i = np.floor(xs).astype(int)
        i2 = np.minimum(i + 1, pts - 1)
        f = xs - i
        f = f * f * (3.0 - 2.0 * f)  # smoothstep
        acc += (ctrl[i] * (1.0 - f) + ctrl[i2] * f) * amp
        norm += amp
        amp *= 0.5
    return np.clip(acc / (norm or 1.0), 0.0, 1.0)


def _shaper_curve(base: np.ndarray, data: dict, fps: int) -> np.ndarray:
    """A shaper node -> optionally delay its input in time, then re-curve it via the
    EXACT studio shaping order (`signals.shape`) and remap into [lo, hi]. The delay
    slides the signal later by `delay` ms; the exposed head is zero-padded, or wraps
    the tail back to the head when `wrap` is set."""
    base = np.clip(np.asarray(base, np.float32), 0.0, 1.0)
    shift = int(round(float(data.get("delay", 0.0)) / 1000.0 * fps))
    n = len(base)
    if shift > 0 and n:
        if data.get("wrap"):
            base = np.roll(base, shift)  # tail wraps back to the head
        elif shift < n:
            base = np.concatenate([np.zeros(shift, np.float32), base[:-shift]])
        else:
            base = np.zeros(n, np.float32)  # shifted entirely off the clip
    y = signals.shape(
        base,
        attack=float(data.get("attack", 5.0)),
        release=float(data.get("release", 250.0)),
        invert=bool(data.get("invert", False)),
        gamma=float(data.get("gamma", 1.0)),
        gain=float(data.get("gain", 1.0)),
        offset=float(data.get("offset", 0.0)),
        threshold=float(data.get("threshold", 0.0)),
        fps=fps,
    )
    lo, hi = float(data.get("lo", 0.0)), float(data.get("hi", 1.0))
    return np.clip(lo + (hi - lo) * y, 0.0, 1.0).astype(np.float32)


def _math_combine(curves: list, op: str, mix: float, nframes: int) -> np.ndarray:
    """Fold value curves with `op` (elementwise), clamp 0..1. `mix` crossfades the
    first two inputs for op "mix"; missing inputs are flat 0."""
    if not curves:
        return np.zeros(nframes, np.float32)
    if op == "mix":
        a = curves[0]
        b = curves[1] if len(curves) > 1 else np.zeros(nframes, np.float32)
        out = a * (1.0 - mix) + b * mix
    else:
        out = curves[0].astype(np.float32).copy()
        for c in curves[1:]:
            if op == "add":
                out = out + c
            elif op == "subtract":
                out = out - c
            elif op == "max":
                out = np.maximum(out, c)
            elif op == "min":
                out = np.minimum(out, c)
            else:  # multiply (default)
                out = out * c
    return np.clip(out.astype(np.float32), 0.0, 1.0)


def _make_value_resolver(graph, nodes, job_id, start, end, nframes, fps, signals_by_id, stem_audio_path):
    """A memoized value resolver: `node_id` -> 0..1 curve (length nframes),
    type-dispatched (signal / lfo / noise / shaper / math) and recursing through value
    inputs. A zeros placeholder is seeded before recursing so a (validate-rejected)
    cycle degrades to flat 0 instead of looping forever. Shared by `build_params`
    (fluid ports) and `_Dag` (FX-card ports)."""
    cache: dict[str, np.ndarray] = {}

    def resolve_source(node_id: str) -> np.ndarray:
        if node_id in cache:
            return cache[node_id]
        cache[node_id] = np.zeros(nframes, np.float32)  # cycle guard + default
        node = nodes.get(node_id)
        if node is None:
            return cache[node_id]
        t = node.get("type")
        data = node.get("data", {})
        if t == "signal":
            out = _signal_curve(node, job_id, start, end, nframes, signals_by_id, stem_audio_path)
        elif t == "lfo":
            out = _lfo_curve(data, nframes, fps)
        elif t == "noise":
            out = _noise_curve(data, nframes, fps)
        elif t == "shaper":
            src = _video_source(graph, node_id, "in")
            base = resolve_source(src) if src else np.zeros(nframes, np.float32)
            out = _shaper_curve(base, data, fps)
        elif t == "scope":
            # a pure monitor: passes its input value through unchanged.
            src = _video_source(graph, node_id, "in")
            out = resolve_source(src) if src else np.zeros(nframes, np.float32)
        elif t == "math":
            ins = []
            for pid in data.get("inputs", []):
                src = _video_source(graph, node_id, pid)
                ins.append(resolve_source(src) if src else np.zeros(nframes, np.float32))
            out = _math_combine(ins, data.get("op", "multiply"), float(data.get("mix", 0.5)), nframes)
        else:
            out = np.zeros(nframes, np.float32)
        cache[node_id] = out
        return out

    return resolve_source


def resolve_node_curve(job_id, segment, graph, node_id, stem_audio_path, fps: int = 30) -> dict:
    """Resolve ONE value node's 0..1 curve over the segment — for the Scope card's live
    view. Reuses the executor's value resolver, so it shows exactly what the node feeds
    into the graph. Returns ``{curve, times, fps}``; a missing node degrades to flat 0."""
    start, end = float(segment.get("start", 0.0)), float(segment.get("end", 0.0))
    nframes = max(1, round((end - start) * fps))
    nodes = {n["id"]: n for n in graph.get("nodes", []) if "id" in n}
    signals_by_id = {s["id"]: s for s in segment.get("signals", []) if "id" in s}
    resolve = _make_value_resolver(graph, nodes, job_id, start, end, nframes, fps, signals_by_id, stem_audio_path)
    curve = resolve(node_id) if node_id in nodes else np.zeros(nframes, np.float32)
    times = np.arange(nframes, dtype=np.float32) / float(fps) + start
    return {
        "curve": [round(float(v), 4) for v in curve],
        "times": [round(float(t), 3) for t in times],
        "fps": fps,
    }


# --------------------------------------------------------------------------- #
# Points cards (spec 02): parametric layouts + transforms -> emitter source specs
# --------------------------------------------------------------------------- #
_POINT_CAP = 64  # max emitters a points pipeline can produce (bounds the merge)


def _clamp01(v) -> float:
    return max(0.0, min(1.0, float(v)))


def _static_point_spec(p) -> dict:
    """A fixed point -> a static (path-less) emitter source spec."""
    return {"points": [[_clamp01(p[0]), _clamp01(p[1])]], "path_speed": 0}


def _pattern_points(data: dict) -> list:
    """A parametric layout -> a list of (x, y). Mirrors frontend lib/pointsGen.ts
    (scatter uses numpy's RNG, so its exact dots differ from the card preview, but
    both are a seeded random scatter)."""
    layout = data.get("layout", "circle")
    count = int(max(1, min(_POINT_CAP, round(float(data.get("count", 6))))))
    radius = _clamp01(data.get("radius", 0.3))
    rot = np.deg2rad(float(data.get("rotation", 0.0)))
    cx = 0.5 + float(data.get("offsetX", 0.0))
    cy = 0.5 + float(data.get("offsetY", 0.0))
    out = []
    if layout == "grid":
        cols = max(1, round(count**0.5))
        rows = int(np.ceil(count / cols))
        ext = radius or 0.4
        for i in range(count):
            fx = (i % cols) / (cols - 1) - 0.5 if cols > 1 else 0.0
            fy = (i // cols) / (rows - 1) - 0.5 if rows > 1 else 0.0
            out.append((_clamp01(cx + fx * ext * 2), _clamp01(cy + fy * ext * 2)))
    elif layout == "line":
        ext = radius or 0.4
        for i in range(count):
            t = i / (count - 1) - 0.5 if count > 1 else 0.0
            out.append(
                (_clamp01(cx + np.cos(rot) * t * ext * 2), _clamp01(cy + np.sin(rot) * t * ext * 2))
            )
    elif layout == "spiral":
        for i in range(count):
            t = i / (count - 1) if count > 1 else 0.0
            ang = rot + t * 3 * 2 * np.pi
            out.append((_clamp01(cx + np.cos(ang) * radius * t), _clamp01(cy + np.sin(ang) * radius * t)))
    elif layout == "scatter":
        rng = np.random.default_rng(int(data.get("seed", 1)))
        for _ in range(count):
            ang = rng.random() * 2 * np.pi
            rr = (rng.random() ** 0.5) * radius
            out.append((_clamp01(cx + np.cos(ang) * rr), _clamp01(cy + np.sin(ang) * rr)))
    else:  # circle / ring
        for i in range(count):
            ang = rot + (i / count) * 2 * np.pi
            out.append((_clamp01(cx + np.cos(ang) * radius), _clamp01(cy + np.sin(ang) * radius)))
    return out


def _animate_point_specs(specs: list, data: dict) -> list:
    """Give each point a PATH so it moves over the clip (reuses the fluid source-path
    machinery): orbit = a ring about the centre, drift = a line along a heading. chase
    keeps the points fixed and cycles WHICH ones emit — a sliding lit window of `count`
    points sweeping the set at `rate`, via per-source emission gate fields."""
    mode = data.get("mode", "orbit")
    amount = _clamp01(data.get("amount", 0.15))
    rate = float(data.get("rate", 1.0))
    if mode == "chase":
        n = len(specs)
        if not n:
            return []
        count = int(max(1, min(n, round(float(data.get("count", 1))))))
        duty = count / n
        fade = _clamp01(data.get("fade", 0.0))
        return [
            {**s, "gate_speed": rate, "gate_phase": j / n, "gate_duty": duty, "gate_fade": fade}
            for j, s in enumerate(specs)
        ][:_POINT_CAP]
    out = []
    for s in specs:
        bx, by = float(s["points"][0][0]), float(s["points"][0][1])
        if mode == "drift":
            ang = np.deg2rad(float(data.get("angle", 0.0)))
            path = [
                [_clamp01(bx), _clamp01(by)],
                [_clamp01(bx + np.cos(ang) * amount), _clamp01(by + np.sin(ang) * amount)],
            ]
            out.append({"points": path, "path_speed": rate, "path_pingpong": True})
        else:  # orbit
            start = np.arctan2(by - 0.5, bx - 0.5)
            path = [
                [_clamp01(0.5 + np.cos(start + (k / 16) * 2 * np.pi) * amount),
                 _clamp01(0.5 + np.sin(start + (k / 16) * 2 * np.pi) * amount)]
                for k in range(16)
            ]
            out.append({"points": path, "path_speed": rate, "path_closed": True})
    return out[:_POINT_CAP]


def build_params(
    job_id: str,
    segment: dict,
    graph: dict,
    stem_audio_path: Callable,
    output: dict | None = None,
    output_id: str | None = None,
    fluid_node: dict | None = None,
) -> dict:
    """Resolve `graph` into a `simulate()` params dict (no render).

    Split out from `render` so tests can assert the per-frame arrays without
    encoding an mp4. Each modulatable port becomes a scalar (const binding) or a
    length-nframes native-unit array (node binding mapped lo + (hi-lo)*curve).

    `output_id` selects which output's fluid to build (N pipelines per graph);
    when omitted, the sole fluid is used (back-compat).
    `output` carries the project render settings (size/quality/fps/background);
    when present it drives the grid + fps (the legacy square `grid` is dropped).
    """
    output = output or {}
    nodes = {n["id"]: n for n in graph["nodes"]}
    if fluid_node is None:
        fluid_node = (
            _fluid_for_output(graph, output_id) if output_id else _nodes_of(graph, "fluid")[0]
        )
    start, end = float(segment["start"]), float(segment["end"])
    signals_by_id = {s["id"]: s for s in segment.get("signals", []) if "id" in s}
    static = fluid_node["data"].get("static", {})
    # The clip is ALWAYS the full segment — duration is not a graph/card setting.
    duration = max(0.5, end - start)
    fps = int(output.get("fps", FLUID_FPS))
    # Per-frame arrays must match simulate()'s frame count, which uses this fps.
    nframes = max(1, round(duration * fps))

    # Memoized, type-dispatched node resolution -> 0..1 curve, length nframes.
    resolve_source = _make_value_resolver(
        graph, nodes, job_id, start, end, nframes, fps, signals_by_id, stem_audio_path
    )

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
            curve = resolve_source(binding["nodeId"])  # 0..1, len nframes
            target[key] = (lo + (hi - lo) * curve).tolist()  # native-unit array

    # Dye colour comes from a `color` card wired into the fluid's `color` input (or the
    # static fallback when unwired). Overrides the static `color` vector under source.
    src_params.update(_resolve_fluid_color(graph, fluid_node, nodes, resolve_source))

    params = {
        "duration": duration,
        "fps": fps,
        "source": {**_source_statics(static), **src_params},
        "fluid": fluid_params,
    }
    if output:
        params["output"] = _output_params(output, fps)
    else:
        params["grid"] = int(static.get("grid", LEGACY_GRID))  # legacy square fallback
    return params


# --------------------------------------------------------------------------- #
# Render
# --------------------------------------------------------------------------- #
class _Dag:
    """Resolves the video DAG feeding an output (spec 10).

    Two memoized resolvers walk the producers (fluid / combine / output-passthrough)
    upstream of an output, each dispatching on node `type`:

      video(id)    -> dye-on-transparent frames for ANY producer. fluid: run the
                      sim; output: pass its input through; combine: composite the
                      stacked layers (mode="stack") or sim the merged emitters.
      emitters(id) -> the flat emitter list a MERGE feeds into one shared sim.
                      fluid: its source(s); output: its input's emitters; combine:
                      the concatenated inputs (a layered/stack combine has no single
                      emitter set, so it can't feed a merge — raises).

    Per-render memo dicts (`_video`/`_emit`/`_params`) keep each node's resolution
    to once. The terminal (`render`) applies the project background after `video`."""

    def __init__(self, job_id, segment, graph, stem_audio_path, output):
        self.job_id = job_id
        self.segment = segment
        self.graph = graph
        self.stem_audio_path = stem_audio_path
        self.output = output or {}
        self.nodes = {n["id"]: n for n in graph.get("nodes", []) if "id" in n}
        start, end = float(segment["start"]), float(segment["end"])
        self.duration = max(0.5, end - start)
        self.fps = int(self.output.get("fps", FLUID_FPS))
        self._video: dict = {}
        self._emit: dict = {}
        self._params: dict = {}
        self._block_fns: dict = {}  # node_id -> produce(a, b) (block streaming)
        self._executors: list = []  # per-combine branch pools, shut down by stream_blocks
        self._cache_writers: list = []  # discard() for incremental frame caches (cancel cleanup)

    def _fluid_params(self, fluid_node):
        # Memoized per fluid: a fluid with drawn points resolves params through both
        # the video path and the emitter path, and each build_params re-extracts the
        # node's signal curves — cache so the (expensive) resolution runs once.
        fid = fluid_node["id"]
        if fid not in self._params:
            self._params[fid] = build_params(
                self.job_id,
                self.segment,
                self.graph,
                self.stem_audio_path,
                self.output,
                fluid_node=fluid_node,
            )
        return self._params[fid]

    def _resolve_points(self, node_id, seen=None) -> list:
        """A points node -> a list of emitter source SPECS (each carries `points` + path
        fields). Dispatches on type and recurses through the points transforms
        (animate); a (validate-rejected) cycle degrades to []."""
        seen = seen if seen is not None else set()
        if node_id in seen:
            return []
        seen.add(node_id)
        node = self.nodes.get(node_id)
        if node is None:
            return []
        t = node.get("type")
        data = node.get("data", {})
        if t == "points":
            return [_static_point_spec(p) for p in (data.get("points") or [])]
        if t == "pattern":
            return [_static_point_spec(p) for p in _pattern_points(data)]
        if t == "animate-points":
            src = _video_source(self.graph, node_id, "in")
            return _animate_point_specs(self._resolve_points(src, seen) if src else [], data)
        if t == "merge-points":
            # Concatenate every wired input's point specs into one set (capped).
            merged: list = []
            for pid in data.get("inputs") or []:
                src = _video_source(self.graph, node_id, pid)
                if src:
                    merged.extend(self._resolve_points(src, seen))
            return merged[:_POINT_CAP]
        return []

    def _points_for(self, fluid_node):
        """The point SPECS wired into `fluid.positions` (any points-flow card), or None
        when nothing is wired — then the fluid keeps its single source (spec 11)."""
        pid = _video_source(self.graph, fluid_node["id"], "positions")
        specs = self._resolve_points(pid) if pid else []
        return specs or None

    def _fluid_emitters(self, fluid_node) -> list:
        """A fluid's emitter list: ONE source per resolved point (sharing the fluid's
        params; a spec overrides position + path), or the single source when none."""
        base = self._fluid_params(fluid_node)["source"]
        specs = self._points_for(fluid_node)
        if not specs:
            return [base]
        return [{**base, **spec} for spec in specs]

    def _fluid_video_params(self, fluid_node) -> dict:
        """simulate() params for one fluid — `sources` when points are wired, else
        the single `source` (byte-identical to the prior single-source path)."""
        params = self._fluid_params(fluid_node)
        if self._points_for(fluid_node):
            params = {**params, "sources": self._fluid_emitters(fluid_node)}
            params.pop("source", None)
        return params

    def _fx_params(self, node) -> dict:
        """A non-fluid ported card's modulatable ports (FX or source) -> {key:
        length-nframes native array}. Reuses the shared value resolver, so a port wired
        to a signal/LFO/math resolves exactly like a fluid param does."""
        nframes = max(1, round(self.duration * self.fps))
        seg = self.segment
        signals_by_id = {s["id"]: s for s in seg.get("signals", []) if "id" in s}
        resolve = _make_value_resolver(
            self.graph,
            self.nodes,
            self.job_id,
            float(seg["start"]),
            float(seg["end"]),
            nframes,
            self.fps,
            signals_by_id,
            self.stem_audio_path,
        )
        out = {}
        for key, (pmin, pmax, pdef) in _PORT_SPECS[node["type"]].items():
            b = (node.get("data", {}).get("ports", {}).get(key) or {}).get("binding")
            if not b or b.get("kind") == "const":
                out[key] = np.full(nframes, float(b["value"]) if b else pdef, np.float32)
            else:
                lo, hi = float(b.get("lo", pmin)), float(b.get("hi", pmax))
                out[key] = (lo + (hi - lo) * resolve(b["nodeId"])).astype(np.float32)
        return out

    def _merge_params(self, emitters, medium):
        params = {
            "duration": self.duration,
            "fps": self.fps,
            "sources": emitters,
            "fluid": {k: float(medium.get(k, d)) for k, d in _MERGE_MEDIUM_DEFAULTS},
        }
        if self.output:
            params["output"] = _output_params(self.output, self.fps)
        else:
            params["grid"] = LEGACY_GRID
        return params

    def emitters(self, node_id) -> list:
        """The flat emitter list a MERGE feeds into one shared sim. Dispatches on
        node type via `_EMITTER_HANDLERS`; memoized per render."""
        if node_id in self._emit:
            return self._emit[node_id]
        node = self.nodes[node_id]
        handler = _EMITTER_HANDLERS.get(node.get("type"))
        if handler is None:
            raise ValueError(f"node '{node_id}' has no emitter")
        out = handler(self, node)
        self._emit[node_id] = out
        return out

    def video(self, node_id) -> np.ndarray:
        """Dye-on-transparent frames for any producer. Dispatches on node type via
        `_VIDEO_HANDLERS`; memoized per render."""
        if node_id in self._video:
            return self._video[node_id]
        node = self.nodes[node_id]
        handler = _VIDEO_HANDLERS.get(node.get("type"))
        if handler is None:
            raise ValueError(f"node '{node_id}' is not a video producer")
        frames = handler(self, node)
        self._video[node_id] = frames
        return frames

    # ----------------------------------------------------------------------- #
    # Block streaming (progressive render): the same DAG, produced in contiguous
    # front-to-back frame blocks so a long clip previews in ~5s chunks. Mirrors
    # `video()` but every handler yields frames for a range [a, b) instead of the
    # whole clip; the only stateful producer (fluid/merge) carries its `FluidClip`
    # across blocks (block K+1's field IS block K's — it can't be parallelised in
    # time). Downstream ops (composite/fx/lyrics) are per-frame stateless, so they
    # just operate on the block + the sliced param arrays.
    def _block_producer(self, node_id):
        """A `produce(a, b) -> frames[a:b]` callable for a node, memoized so a
        producer shared by two consumers computes each block once. Callers must
        pull contiguous, increasing ranges (front-to-back)."""
        if node_id in self._block_fns:
            return self._block_fns[node_id]
        node = self.nodes[node_id]
        handler = _BLOCK_HANDLERS.get(node.get("type"))
        if handler is None:
            raise ValueError(f"node '{node_id}' is not a video producer")
        inner = handler(self, node)
        cache: dict = {"key": None, "val": None}  # last block, so re-pulls are free
        lock = threading.Lock()  # a diamond graph can pull one producer from 2 branches

        def produce(a, b):
            with lock:  # serialise concurrent pulls of the SAME producer (stateful sim)
                if cache["key"] != (a, b):
                    cache["key"] = (a, b)
                    cache["val"] = inner(a, b)
                return cache["val"]

        self._block_fns[node_id] = produce
        return produce

    def stream_blocks(self, output_id, block_frames):
        """Yield `(a, b, total, frames)` dye-on-transparent blocks feeding `output_id`.
        `total` is the clip's frame count. The terminal (`render_stream`) applies the
        background per block and streams it to the encoder. Owns the lifetime of the
        per-combine branch pools built while wiring the producers — shut down on exit."""
        src = _video_source(self.graph, output_id, "video")
        if src is None:
            raise ValueError(f"output '{output_id}' has no input")
        produce = self._block_producer(src)  # builds the producer chain (+ branch pools)
        total = max(1, round(self.duration * self.fps))
        block_frames = max(1, int(block_frames))
        try:
            a = 0
            while a < total:
                b = min(a + block_frames, total)
                yield a, b, total, produce(a, b)
                a = b
        finally:
            for ex in self._executors:
                ex.shutdown(wait=False)
            self._executors.clear()
            for discard in self._cache_writers:  # drop partial caches (no-op if committed)
                discard()
            self._cache_writers.clear()


# --------------------------------------------------------------------------- #
# Node-type handler registry (spec 10)
# --------------------------------------------------------------------------- #
# One video handler (and, where it can feed a merge, one emitter handler) per node
# type. A handler is `(dag, node) -> frames | emitters` and may recurse through
# `dag.video` / `dag.emitters`. Adding a producing node type = write a handler +
# register it here; `_Dag.video`/`emitters` and `_VIDEO_PRODUCERS` pick it up.


# The stateful fluid sim is the expensive part of a render, so its raw output is
# cached by `fluid.params_hash` (see fluid_cache): a downstream-only edit (grade / FX
# / background) leaves the fluid params — hence the key — unchanged, so we reuse the
# frames and only the cheap per-frame ops re-run. Both the whole-clip and block paths
# go through these so the cache is shared between the sync and streaming renders.
def _fluid_cache_key(params: dict) -> str:
    """Cache key for a fluid node's raw frames. The sim runs with apply_bg=False, so
    the project `background` never touches the dye-on-transparent frames — drop it from
    the key, otherwise a background-only edit would miss the cache and re-run the sim.
    Grid/fps/quality stay in the key: they DO change the frames (size + count)."""
    out = params.get("output")
    if out and "background" in out:
        params = {**params, "output": {k: v for k, v in out.items() if k != "background"}}
    return fluid.params_hash(params)


def _sim_video(params: dict) -> np.ndarray:
    """Fluid frames for `params`, from the cache when hot else simulate + store.
    Always dye-on-transparent (apply_bg=False); the terminal adds the background."""
    key = _fluid_cache_key(params)
    cached = fluid_cache.load(key)
    if cached is not None:
        return np.array(cached)  # writable copy off the read-only mmap
    frames, _, _ = fluid.simulate(params, apply_bg=False)
    fluid_cache.store(key, frames)
    return frames


def _sim_blocks(dag: "_Dag", params: dict):
    """A `produce(a, b)` fluid block source backed by the frame cache: a hit slices
    the cached array (no sim); a miss runs a resumable FluidClip and streams the frames
    straight into the cache (memmap) as blocks are produced. Registers a `discard` on
    the dag so an abandoned (cancelled) render drops its partial cache file."""
    key = _fluid_cache_key(params)
    cached = fluid_cache.load(key)
    if cached is not None:
        return lambda a, b: np.array(cached[a:b])
    clip = fluid.FluidClip(params, apply_bg=False)
    # Stream frames straight into the cache as they're produced (O(1) memory) instead
    # of holding the whole clip to write at the end; finalize on the last block.
    mm, finalize, discard = fluid_cache.frame_writer(key, (clip.nframes, clip.gh, clip.gw, 3))
    dag._cache_writers.append(discard)

    def produce(a, b):
        blk = clip.advance(a, b)
        if mm is not None:
            mm[a:b] = blk
            if b >= clip.nframes:  # last block done -> commit the cached clip
                finalize()
        return blk

    return produce


def _fluid_video(dag: "_Dag", node: dict) -> np.ndarray:
    return _sim_video(dag._fluid_video_params(node))


def _output_video(dag: "_Dag", node: dict) -> np.ndarray:
    src = _video_source(dag.graph, node["id"], "video")
    if src is None:
        raise ValueError(f"output '{node['id']}' has no input to pass through")
    return dag.video(src)


def _combine_video(dag: "_Dag", node: dict) -> np.ndarray:
    data = node.get("data", {})
    srcs = [(_video_source(dag.graph, node["id"], s.get("id")), s) for s in data.get("inputs", [])]
    srcs = [(s, slot) for (s, slot) in srcs if s is not None]
    if not srcs:
        raise ValueError(f"combine '{node['id']}' has no inputs")
    if data.get("mode") == "stack":
        layers = [dag.video(s) for (s, _) in srcs]
        opac = [float(slot.get("opacity", 1.0)) for (_, slot) in srcs]
        return composite(layers, opac)
    # merge: each emitter keeps its OWN `wrap` (from its source fluid). They share
    # ONE velocity field (so they interact) but each component's dye advects with its
    # own edge behaviour — see fluid.simulate().
    params = dag._merge_params(dag.emitters(node["id"]), data.get("medium", {}))
    return _sim_video(params)


def _fluid_emitters_h(dag: "_Dag", node: dict) -> list:
    return dag._fluid_emitters(node)


def _output_emitters_h(dag: "_Dag", node: dict) -> list:
    src = _video_source(dag.graph, node["id"], "video")
    return dag.emitters(src) if src else []


def _combine_emitters_h(dag: "_Dag", node: dict) -> list:
    if node.get("data", {}).get("mode") == "stack":
        raise ValueError("a layered (stack) combine can't feed a merge combine")
    out: list = []
    for slot in node.get("data", {}).get("inputs", []):
        src = _video_source(dag.graph, node["id"], slot.get("id"))
        if src:
            out.extend(dag.emitters(src))
    return out


def _grid_dims(dag: "_Dag"):
    """The (gh, gw) frame size for a synthesised source — the project output grid, or
    the legacy square when no output settings are present."""
    if dag.output:
        return fluid.grid_from_output(dag.output)
    return LEGACY_GRID, LEGACY_GRID


def _lyrics_video(dag: "_Dag", node: dict) -> np.ndarray:
    d = node.get("data", {})
    nframes = max(1, round(dag.duration * dag.fps))
    gh, gw = _grid_dims(dag)
    lines = dag.segment.get("lyric_lines") or []
    return sources.lyrics(
        nframes,
        gh,
        gw,
        dag.fps,
        lines=lines,
        seg_start=float(dag.segment.get("start", 0.0)),
        position=d.get("position", "bottom"),
        align=d.get("align", "center"),
        case=d.get("case", "none"),
        reveal=d.get("reveal", "word"),
        **dag._fx_params(node),
    )


_VIDEO_HANDLERS = {
    "fluid": _fluid_video,
    "output": _output_video,
    "combine": _combine_video,
    "lyrics": _lyrics_video,
}
_EMITTER_HANDLERS = {
    "fluid": _fluid_emitters_h,
    "output": _output_emitters_h,
    "combine": _combine_emitters_h,
}


# --------------------------------------------------------------------------- #
# Block-streaming handlers: `(dag, node) -> produce(a, b)`. Each mirrors the
# matching `_VIDEO_HANDLERS` entry but produces one frame block. Setup (params,
# FluidClip, upstream producers) runs ONCE when the closure is built; `produce`
# is called per block. Keep these in lockstep with the video handlers above.
def _fluid_block(dag: "_Dag", node: dict):
    return _sim_blocks(dag, dag._fluid_video_params(node))


def _output_block(dag: "_Dag", node: dict):
    src = _video_source(dag.graph, node["id"], "video")
    if src is None:
        raise ValueError(f"output '{node['id']}' has no input to pass through")
    return dag._block_producer(src)


def _combine_block(dag: "_Dag", node: dict):
    data = node.get("data", {})
    srcs = [(_video_source(dag.graph, node["id"], s.get("id")), s) for s in data.get("inputs", [])]
    srcs = [(s, slot) for (s, slot) in srcs if s is not None]
    if not srcs:
        raise ValueError(f"combine '{node['id']}' has no inputs")
    if data.get("mode") == "stack":
        producers = [dag._block_producer(s) for (s, _) in srcs]
        opac = [float(slot.get("opacity", 1.0)) for (_, slot) in srcs]
        # One pool per combine, built ONCE and reused for every block (not per-block);
        # its own pool per combine keeps nested stack-combines deadlock-free. The dag
        # owns shutdown (stream_blocks' finally). numpy releases the GIL for the
        # FFT/advection, so the branches are genuinely parallel.
        ex = ThreadPoolExecutor(max_workers=len(producers)) if len(producers) > 1 else None
        if ex is not None:
            dag._executors.append(ex)

        def produce(a, b):
            if ex is None:
                return composite([producers[0](a, b)], opac)
            layers = list(ex.map(lambda p: p(a, b), producers))  # map preserves order
            return composite(layers, opac)

        return produce
    # merge: one shared sim over the concatenated emitters (see _combine_video).
    return _sim_blocks(dag, dag._merge_params(dag.emitters(node["id"]), data.get("medium", {})))


def _lyrics_block(dag: "_Dag", node: dict):
    d = node.get("data", {})
    gh, gw = _grid_dims(dag)
    lines = dag.segment.get("lyric_lines") or []
    params = dag._fx_params(node)  # size/r/g/b/opacity, sliced per block
    kw = dict(
        lines=lines,
        seg_start=float(dag.segment.get("start", 0.0)),
        position=d.get("position", "bottom"),
        align=d.get("align", "center"),
        case=d.get("case", "none"),
        reveal=d.get("reveal", "word"),
    )

    def produce(a, b):
        return sources.lyrics(
            b - a, gh, gw, dag.fps, frame_offset=a, **kw, **{k: v[a:b] for k, v in params.items()}
        )

    return produce


_BLOCK_HANDLERS = {
    "fluid": _fluid_block,
    "output": _output_block,
    "combine": _combine_block,
    "lyrics": _lyrics_block,
}
# Node types that produce a video stream (used by validate to check output wiring).
_VIDEO_PRODUCERS = tuple(_VIDEO_HANDLERS)


def render(
    job_id: str,
    segment: dict,
    graph: dict,
    stem_audio_path: Callable,
    output: dict | None = None,
    output_id: str | None = None,
) -> str:
    """Resolve one output's video DAG for `segment`, render an mp4, return its URL.

    Walks the producers feeding `output_id` (fluid / combine / output-passthrough),
    rendering dye-on-transparent frames, then applies the project background ONCE
    here at the terminal. `output_id` selects which output (N pipelines per graph).
    Cached by the per-output contributing-subgraph hash. Raises ValueError on a bad
    graph (HTTP 400). `stem_audio_path(job_id, stem)` is injected from app.py.
    """
    output = output or {}
    validate(graph)
    if output_id is None:
        output_id = _nodes_of(graph, "output")[0]["id"]
    out_path = ANIM_DIR / f"{output_hash(job_id, segment, graph, output_id, output)}.mp4"
    url = f"/fluid/{out_path.name}"
    if out_path.exists():
        render_cache.touch(out_path)  # keep this hot clip from aging out (LRU)
        return url

    src = _video_source(graph, output_id, "video")
    if src is None:
        raise ValueError(f"output '{output_id}' has no input")
    dag = _Dag(job_id, segment, graph, stem_audio_path, output)
    frames = dag.video(src)
    frames = fluid.apply_background(frames, output.get("background", "#000000"))
    out_w = int(output.get("width", 0)) or None
    out_h = int(output.get("height", 0)) or None
    fluid.render_mp4(frames, dag.fps, out_path, out_w, out_h)
    render_cache.evict(ANIM_DIR)  # bound the cache after adding a clip
    return url


def _encoder_error(enc: "subprocess.Popen") -> str:
    """Drain a finished/broken stream encoder's stderr into a RuntimeError message."""
    try:
        err = enc.stderr.read() or b""
    except OSError:
        err = b""
    return err.decode(errors="replace")[-2000:] or "ffmpeg stream encoder failed"


def render_stream(
    job_id: str,
    segment: dict,
    graph: dict,
    stem_audio_path: Callable,
    output: dict | None = None,
    output_id: str | None = None,
    *,
    on_progress: Callable | None = None,
    should_cancel: Callable | None = None,
    block_seconds: float = RENDER_BLOCK_SECONDS,
) -> str | None:
    """Progressive render: encode `output_id`'s clip in front-to-back blocks into ONE
    growing (fragmented) mp4, and return the final clip URL.

    A single persistent ffmpeg is fed each block's frames on its stdin (see
    `fluid.open_stream_encoder`); the fragmented layout means the file is playable
    while it grows, so the preview appears after ~one block instead of the whole clip.
    Same `output_hash` / cache path as `render()`, so a finished stream is a normal
    cache hit for the sync path and vice-versa. `on_progress(frames_done, total,
    preview_url)` fires per block (the URL carries a `?n=` cache-buster so the client
    reloads the grown file), and once more with the final URL on completion.
    `should_cancel()` is polled between blocks; True stops early — the encoder is
    killed, the scratch dir dropped, and None returned.
    """
    output = output or {}
    validate(graph)
    if output_id is None:
        output_id = _nodes_of(graph, "output")[0]["id"]
    out_path = ANIM_DIR / f"{output_hash(job_id, segment, graph, output_id, output)}.mp4"
    url = f"/fluid/{out_path.name}"
    dag = _Dag(job_id, segment, graph, stem_audio_path, output)
    total = max(1, round(dag.duration * dag.fps))
    if out_path.exists():  # already rendered — nothing to stream
        render_cache.touch(out_path)
        if on_progress:
            on_progress(total, total, url)
        return url

    out_w = int(output.get("width", 0)) or None
    out_h = int(output.get("height", 0)) or None
    bg = output.get("background", "#000000")
    gh, gw = _grid_dims(dag)
    block_frames = max(1, round(block_seconds * dag.fps))
    # Unique per render (not just per output hash) so two concurrent renders of the
    # same output can't share — and rmtree — one scratch dir.
    render_id = out_path.stem + uuid.uuid4().hex[:8]
    scratch = STREAM_DIR / render_id
    scratch.mkdir(parents=True, exist_ok=True)
    preview = scratch / "preview.mp4"
    enc: "subprocess.Popen | None" = None
    try:
        for k, (_a, b, tot, block) in enumerate(dag.stream_blocks(output_id, block_frames)):
            if should_cancel and should_cancel():
                return None
            data = fluid.apply_background(block, bg).tobytes()
            if enc is None:  # open the encoder lazily on the first block
                enc = fluid.open_stream_encoder(preview, dag.fps, gw, gh, out_w, out_h)
            try:
                enc.stdin.write(data)
            except BrokenPipeError as exc:
                raise RuntimeError(_encoder_error(enc)) from exc
            if on_progress:
                on_progress(b, tot, f"/fluid/stream/{render_id}/preview.mp4?n={k}")
        if enc is not None:  # finalize: flush the encoder, promote to the cache path
            enc.stdin.close()
            enc.wait()
            if enc.returncode != 0:
                raise RuntimeError(_encoder_error(enc))
            enc = None
            shutil.move(str(preview), str(out_path))
            render_cache.evict(ANIM_DIR)
        if on_progress:
            on_progress(total, total, url)
        return url
    finally:
        if enc is not None and enc.poll() is None:  # cancelled / errored mid-stream
            try:
                enc.stdin.close()
            except OSError:
                pass
            enc.terminate()
            try:
                enc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                enc.kill()
        shutil.rmtree(scratch, ignore_errors=True)
