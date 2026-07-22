"""Shared graph primitives: constants, edge/node lookups, and the composite step.

The leaf module of the graph package — every other graph_* module imports from
here, and this imports only the param specs, so the split stays cycle-free.
"""

from __future__ import annotations

import numpy as np

from . import sources
from .animation_params import COLOR_PARAMS, OUTPUT_DEFAULTS

# Modulatable-port specs for the non-fluid ported cards (FX + sources + the color
# card): key -> (min, max, default). The single backend lookup for resolving their
# ports / validating their bindings. The `color` card feeds the fluid's dye colour
# (resolved in build_params), so it never renders a video — but its ports validate here.
_PORT_SPECS = {**sources.SOURCE_PARAMS, "color": COLOR_PARAMS}

FLUID_FPS = 24

# Legacy square-grid fallback (cells per side) for pre-output-settings saves that
# carry no project `output`. The live path derives a rectangular grid from the
# output size (see `fluid.grid_from_output`).
LEGACY_GRID = 96

_POINT_CAP = 64  # max emitters a points pipeline can produce (bounds the merge)


def resolve_port(binding, pmin: float, pmax: float, pdef: float, resolve):
    """One modulatable port -> native units.

    The single definition of the port contract every ported card shares: an absent or
    `const` binding is a plain scalar; a `node` binding maps the upstream 0..1 curve
    through the port's own `[lo, hi]` window. Callers own the shape they need — a
    scalar or a numpy curve comes back, and `build_params` / `_fx_params` / the colour
    resolver each coerce it (`.tolist()`, `np.full`, …) as their consumer requires.

    An unbound port yields `pdef` UNCOERCED: `params_hash` json-dumps these values, so
    floating an int default (`40` -> `40.0`) would rewrite every raw-frame cache key."""
    if not binding or binding.get("kind") == "const":
        return float(binding["value"]) if binding else pdef
    lo = float(binding.get("lo", pmin))
    hi = float(binding.get("hi", pmax))
    return lo + (hi - lo) * resolve(binding["nodeId"])  # 0..1 curve -> native array


def _output_params(output: dict, fps: int) -> dict:
    """The simulate() top-level `output` block from project render settings.

    Shared by `build_params` (single-fluid) and `Dag._merge_params` (merge combine)
    so the size/quality/fps contract lives in one place. `gridCells` (the HD export's
    explicit grid) passes through when present so the sim grid matches the export."""
    out = {
        "width": int(output.get("width", OUTPUT_DEFAULTS["width"])),
        "height": int(output.get("height", OUTPUT_DEFAULTS["height"])),
        "quality": output.get("quality", OUTPUT_DEFAULTS["quality"]),
        "fps": fps,
    }
    if output.get("gridCells"):
        out["gridCells"] = int(output["gridCells"])
    return out


# The frontend's "loose edge" sentinel targetPort (unassigned drop-anywhere wires).
# Loose edges feed nothing: every backend walk (validate, contributing-ids, cycle
# check) must ignore them — mirrored from lib/graph/core.ts LOOSE_PORT.
LOOSE_PORT = "__in"

# Every node type that PRODUCES a video stream. Declared here, in the leaf module, so
# validation can check output wiring without importing the render dispatch table — that
# import was the backend's only circular one (graph_render -> graph_validate ->
# graph_render, worked around with a function-local import) and a layer inversion besides.
# `graph_render` asserts its handler table matches this set, so the two cannot drift.
VIDEO_PRODUCERS = (
    "fluid",
    "output",
    "combine",
    "montage",
    "lyrics",
    "image",
    "slideshow",
    "video",
    "backdrop",
    "transform",
    "stylize",
    "extract",
    "echo",
    "colorgrade",
    "waves",
    "lightning",
    "fire",
    "aurora",
    "rain",
    "clouds",
)


def _video_source(graph: dict, target_id: str, target_port: str):
    """The node id wired into (target_id, target_port) via an edge, or None."""
    for e in graph.get("edges", []):
        if e.get("target") == target_id and e.get("targetPort") == target_port:
            return e.get("source")
    return None


# Node types that can feed a MERGE combine: fluids (dye emitters), fire (heat
# emitters — same solver, so fire merges with fire AND with fluids), and the
# generative simulation cards, which merge homogeneously (two rains share one
# surface, two waves superpose their height fields, ...). The render-side
# dispatch enforces same-kind grouping for the latter (_combine_video).
MERGE_SOURCE_TYPES = ("fluid", "fire", "waves", "rain", "lightning", "aurora", "clouds")


def _is_emitter_source(graph: dict, node_id, nodes: dict, seen=None) -> bool:
    """Whether `node_id` resolves to mergeable emitter(s) for a MERGE — i.e. an
    emitter-bearing card with no layered (stack) combine upstream (a composited
    video has no single emitter set)."""
    seen = seen if seen is not None else set()
    if node_id in seen:
        return False
    seen.add(node_id)
    node = nodes.get(node_id)
    if node is None:
        return False
    t = node.get("type")
    if t in MERGE_SOURCE_TYPES:
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
    """Alpha-over stack of dye frame stacks -> 3-channel dye-on-transparent (spec 10).

    `layers[0]` is the TOP layer. A 3-channel (dye-on-black) layer's coverage is its
    per-pixel brightness (max channel); a 4-channel (RGBA, e.g. lyrics) layer uses its
    explicit alpha instead — so an opaque BLACK outline occludes what's beneath it
    (brightness alone would treat black as transparent). Both times coverage is scaled
    by the layer's `opacity`. The result stays dye-on-transparent, 3-channel (the
    terminal `fluid.flatten` renders it over black)."""
    acc = np.zeros(layers[0].shape[:-1] + (3,), dtype=np.float32)
    for layer, op in zip(reversed(layers), reversed(opacities)):  # bottom -> top
        f = layer.astype(np.float32) / 255.0
        op = float(op)
        if layer.shape[-1] == 4:  # RGBA: explicit alpha, straight (un-premultiplied) rgb
            a = np.clip(f[..., 3:4], 0.0, 1.0) * op
            contrib = f[..., :3] * a
        else:  # dye-on-black: brightness is the coverage, colour is premultiplied
            a = np.clip(f.max(axis=-1, keepdims=True), 0.0, 1.0) * op
            contrib = f * op
        acc = contrib + acc * (1.0 - a)
    return (np.clip(acc, 0.0, 1.0) * 255).astype(np.uint8)


def resolve_signal(node_data: dict, signals_by_id: dict) -> dict | None:
    """The host-segment signal a `signal` node reads.

    Exact `signalId` first. When that dangles — the normal state for a SHARED
    composition rendered under a segment whose default signals carry different
    UUIDs — fall back to a signature match via the node's denormalized `ref`
    snapshot `{stemKey, minHz, maxHz, feature}` (written by the frontend when the
    signal is picked). The matched signal is used WHOLE, its shaping included:
    the contextual time base means the host segment's tuning drives the child.
    None when neither resolves (renders as flat 0, 01 §3.7)."""
    sig = signals_by_id.get((node_data or {}).get("signalId"))
    if sig is not None:
        return sig
    ref = (node_data or {}).get("ref")
    if not isinstance(ref, dict):
        return None
    try:
        want = (
            str(ref.get("stemKey")),
            str(ref.get("feature")),
            float(ref.get("minHz")),
            float(ref.get("maxHz")),
        )
    except (TypeError, ValueError):
        return None
    for s in signals_by_id.values():
        try:
            have = (
                str(s.get("stemKey")),
                str(s.get("feature")),
                float(s.get("minHz")),
                float(s.get("maxHz")),
            )
        except (TypeError, ValueError):
            continue
        if have == want:
            return s
    return None


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


def _field_nodes(graph: dict, output_id: str) -> list[str]:
    """The raw-field producers (`fluid` / `combine(merge)`) feeding `output_id`, in
    video-chain order (used by the continuous song export). A fluid feeding a merge is
    absorbed by the merge, so we stop AT each field and don't recurse into a merge's
    inputs; `output`/`transform`/`grade`/`echo`/`colorgrade`/`combine(stack)` are
    pass-through and recursed; `lyrics` is a generated layer, not a fluid field."""
    nodes = {n["id"]: n for n in graph.get("nodes", []) if "id" in n}
    found: list[str] = []
    seen: set = set()

    def walk(nid):
        if nid is None or nid in seen:
            return
        seen.add(nid)
        node = nodes.get(nid)
        if node is None:
            return
        t = node.get("type")
        if t == "fluid" or (t == "combine" and node.get("data", {}).get("mode") == "merge"):
            found.append(nid)  # a raw field — stop here
        elif t == "combine":  # stack: recurse each layer input
            for slot in node.get("data", {}).get("inputs", []):
                walk(_video_source(graph, nid, slot.get("id")))
        elif t in (
            "output",
            "transform",
            "grade",
            "echo",
            "colorgrade",
            "waves",
            "rain",
        ):  # pass-through (waves/rain refract their
            walk(_video_source(graph, nid, "video"))  # optional video input)
        # lyrics / anything else: not a fluid field, ignore

    walk(output_id)
    return found
