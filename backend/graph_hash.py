"""Render-cache hashing (01 §3.6): a stable content key over ONE output's
contributing subgraph, so each output caches independently and editing one
pipeline never busts another's."""

from __future__ import annotations

import hashlib
import json

from .graph_common import LOOSE_PORT, _nodes_of

# Bump when render SEMANTICS change so stale clips (cached under an old meaning of
# the same graph) are invalidated. Folded into `output_hash`.
#   v2: clip = full segment (duration dropped) + per-frame medium params + r/g/b.
#   v3: combine nodes + video DAG + background applied at the terminal (was per-sim).
#   v4: lyrics rendered at a resolution-independent text size then downscaled to the
#       grid (was rasterised at the coarse sim grid → overflowed small boxes at low qual).
#   v5: transform mirror/kaleidoscope fold fills out-of-frame samples by MIRRORING the
#       edge (was black) → no gaps on a non-square canvas / under rotation.
RENDER_VERSION = 5

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
        if e.get("targetPort") == LOOSE_PORT:
            continue  # an unassigned (loose) wire feeds nothing
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
            # Loose edges are parked UI state — assigning/parking one must not bust
            # the cache of pipelines it merely dangles near.
            if e.get("targetPort") != LOOSE_PORT
            and e.get("source") in contributing
            and e.get("target") in contributing
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

