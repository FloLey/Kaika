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
from pathlib import Path
from typing import Callable

import numpy as np

from . import fluid, render_cache, signals
from .animation_params import OUTPUT_DEFAULTS, PARAMS, SOURCE_STATIC_KEYS

log = logging.getLogger("kaika.graph")

# Output (and serving) reuses the existing fluid dir + `/fluid/<name>` route.
ANIM_DIR = Path(__file__).resolve().parent.parent / "data" / "fluid"

FLUID_FPS = 24

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
            raise ValueError(f"output '{out['id']}' must be wired to a fluid or combine")

    fluids = _nodes_of(graph, "fluid")

    # Every fluid port binding must be well-formed (const numeric / node resolves).
    for fl in fluids:
        for key, port in fl.get("data", {}).get("ports", {}).items():
            _validate_binding(key, (port or {}).get("binding") or {}, nodes)

    # Every combine input slot must carry an id (the targetPort a video edge wires to).
    for cb in _nodes_of(graph, "combine"):
        for slot in cb.get("data", {}).get("inputs", []):
            if not slot.get("id"):
                raise ValueError(f"combine '{cb['id']}' has an input slot with no id")

    # A merge combine's inputs must resolve to fluid emitters (no layered/stack
    # combine upstream — a composited video has no single emitter set).
    for cb in _nodes_of(graph, "combine"):
        if cb.get("data", {}).get("mode") == "merge":
            for slot in cb.get("data", {}).get("inputs", []):
                src = _video_source(graph, cb["id"], slot.get("id"))
                if src is not None and not _is_emitter_source(graph, src, nodes):
                    raise ValueError("a layered (stack) combine can't feed a merge combine")

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
    blob = json.dumps(payload, sort_keys=True, default=str).encode()
    return hashlib.sha1(blob).hexdigest()[:16]


# --------------------------------------------------------------------------- #
# Param building
# --------------------------------------------------------------------------- #
def _source_statics(static: dict) -> dict:
    """The static source-nested params (color, path, toggles) from the fluid card."""
    return {k: static[k] for k in SOURCE_STATIC_KEYS if k in static}


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
    cache: dict[str, np.ndarray] = {}

    def resolve_source(node_id: str) -> np.ndarray:
        if node_id in cache:
            return cache[node_id]
        node = nodes[node_id]
        if node["type"] == "signal":
            out = _signal_curve(node, job_id, start, end, nframes, signals_by_id, stem_audio_path)
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
            curve = resolve_source(binding["nodeId"])  # 0..1, len nframes
            target[key] = (lo + (hi - lo) * curve).tolist()  # native-unit array

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

    def _points_for(self, fluid_node):
        """The drawn points wired into `fluid.positions` (a `points` node), or None
        when nothing is wired — then the fluid keeps its single source (spec 11)."""
        pid = _video_source(self.graph, fluid_node["id"], "positions")
        pnode = self.nodes.get(pid) if pid else None
        if pnode and pnode.get("type") == "points":
            pts = pnode.get("data", {}).get("points") or []
            return [(float(a), float(b)) for a, b in pts] or None
        return None

    def _fluid_emitters(self, fluid_node) -> list:
        """A fluid's emitter list: ONE source per drawn point (sharing the fluid's
        params, static at its position), or the single source when no points wired."""
        base = self._fluid_params(fluid_node)["source"]
        pts = self._points_for(fluid_node)
        if not pts:
            return [base]
        return [{**base, "points": [[px, py]], "path_speed": 0} for (px, py) in pts]

    def _fluid_video_params(self, fluid_node) -> dict:
        """simulate() params for one fluid — `sources` when points are wired, else
        the single `source` (byte-identical to the prior single-source path)."""
        params = self._fluid_params(fluid_node)
        if self._points_for(fluid_node):
            params = {**params, "sources": self._fluid_emitters(fluid_node)}
            params.pop("source", None)
        return params

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


# --------------------------------------------------------------------------- #
# Node-type handler registry (spec 10)
# --------------------------------------------------------------------------- #
# One video handler (and, where it can feed a merge, one emitter handler) per node
# type. A handler is `(dag, node) -> frames | emitters` and may recurse through
# `dag.video` / `dag.emitters`. Adding a producing node type = write a handler +
# register it here; `_Dag.video`/`emitters` and `_VIDEO_PRODUCERS` pick it up.


def _fluid_video(dag: "_Dag", node: dict) -> np.ndarray:
    frames, _, _ = fluid.simulate(dag._fluid_video_params(node), apply_bg=False)
    return frames


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
    frames, _, _ = fluid.simulate(params, apply_bg=False)
    return frames


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


_VIDEO_HANDLERS = {
    "fluid": _fluid_video,
    "output": _output_video,
    "combine": _combine_video,
}
_EMITTER_HANDLERS = {
    "fluid": _fluid_emitters_h,
    "output": _output_emitters_h,
    "combine": _combine_emitters_h,
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
