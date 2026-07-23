"""Render-cache hashing (01 §3.6): a stable content key over ONE output's
contributing subgraph, so each output caches independently and editing one
pipeline never busts another's."""

from __future__ import annotations

import hashlib
import json

from .graph_common import LOOSE_PORT, _nodes_of, resolve_signal

# Bump when render SEMANTICS change so stale clips (cached under an old meaning of
# the same graph) are invalidated. Folded into `output_hash`. The full history is in
# docs/render-versions.md — only the last few entries are useful while working here.
#  v10: the change card — a value modulator emitting its input's smoothed |derivative|
#       (units/sec), for gating on musical CHANGE.
#  v11: sim-free graphs (pure video/image/montage layers, stack combines) render at the
#       output's NATIVE resolution (short side capped at 540) instead of the coarse
#       simulation grid — clip previews stopped looking like mush.
#  v12: a video card feeding a MONTAGE slot ignores the `sync="song"` pre-roll — the
#       montage already re-times its inputs, and the pre-roll seeked past the end of any
#       clip shorter than the segment's song offset, freezing a whole slot.
#  v13: the last 8 cards with hand-maintained whole-clip handlers now derive them from
#       their block handler (`_whole_from_block`). Mostly identical restatements, but
#       STYLIZE genuinely changes decoder: the whole-clip path used `sources.video`
#       while the block path used `VideoClip(loop=True)`. The parity test's tolerance
#       could never have proven those byte-identical, so the cached clips are
#       invalidated rather than assumed equivalent.
#  v14: a video card that runs OUT of material with `loop` off now renders BLANK for
#       the rest of its window (was: hold the last frame). In a montage a slot longer
#       than its clip froze on a still for the whole cut; blank is unambiguous, and
#       the card's shortfall warning already reports the deficit. New video cards
#       also default to loop=off, so the same graph can render differently.
#  v15: the Transform card resamples through `cv2.remap` instead of four per-channel
#       `scipy.map_coordinates` calls (98 ms -> 0.4 ms per 1080p RGBA frame). OpenCV
#       computes the bilinear weights in FIXED POINT where scipy used float, so output
#       differs by at most 1 level per channel — verified across all three edge modes
#       and both channel counts, with zero values exceeding 1. Invisible, but not
#       byte-identical, so the cached clips are invalidated rather than assumed
#       equivalent (the same call v13 made).
#  v16: the montage rebuilt on COMPOSITION EXTRACTS (specs/compositions step 03):
#       slots-as-wired-ports became extracts referencing child compositions rendered
#       in private recursive Dags; cuts became the live union of gate rises and
#       manual breakpoints minus per-cut disables; the v12 montage-slot pre-roll
#       exemption is deleted (a child composition's window IS the extract's, so
#       sync="song" pre-rolls correctly inside it). Old montage clips are
#       meaningless under the new semantics.
RENDER_VERSION = 18

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


# Cards whose `data.inputs` is a list of wired SLOTS ({id, …}); an unwired slot is
# invisible to the render, so it must be invisible to the hash too. (The montage
# left this list with the extracts model — its children are data references, and
# every extract is render-visible.)
_SLOT_CARDS = ("combine",)


def _wired_ports(graph: dict) -> set:
    """Every `(target_id, targetPort)` an edge actually feeds (loose wires excluded)."""
    return {
        (e.get("target"), e.get("targetPort"))
        for e in graph.get("edges", [])
        if e.get("targetPort") != LOOSE_PORT
    }


def _node_for_hash(node: dict, wired: set | None = None) -> dict:
    """A node stripped of transient/layout fields (x/y/view) for hashing.

    Slot cards (montage / combine) additionally drop their UNWIRED slots: the render
    already skips them (`_montage_srcs` / `_combine_video` filter on `_video_source`),
    so an empty slot cannot change a single frame — hashing it re-rendered a
    byte-identical clip on every `+ slot`. Wired slots keep their full shape (id,
    span, opacity), so order and per-slot settings still bust the cache."""
    data = node.get("data", {})
    if wired is not None and node.get("type") in _SLOT_CARDS:
        inputs = data.get("inputs")
        if isinstance(inputs, list):
            kept = [
                s for s in inputs if isinstance(s, dict) and (node.get("id"), s.get("id")) in wired
            ]
            if len(kept) != len(inputs):
                data = {**data, "inputs": kept}
    return {"id": node.get("id"), "type": node.get("type"), "data": data}


def _referenced_signal_defs(graph: dict, signals_by_id: dict) -> list[list]:
    """For each `signal` node, the ordered defining-field tuple of its signal.

    Only *referenced* signals are hashed (unrelated signal edits must not bust the
    cache). A missing/deleted signal contributes its id + None fields.
    """
    defs = []
    for node in _nodes_of(graph, "signal"):
        sig_id = node.get("data", {}).get("signalId")
        # Resolve exactly like the render does (exact id, else the `ref` signature
        # fallback) so the hash covers the signal that actually shapes the frames.
        sig = resolve_signal(node.get("data", {}), signals_by_id)
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


def _graph_for_hash(graph: dict, signals_by_id: dict) -> dict:
    """A WHOLE graph canonicalized for hashing: every node stripped of layout,
    unwired slots dropped, loose edges filtered, referenced signal defs resolved.
    Used for the compositions a montage extract references — an extract renders the
    child's ENTIRE output pipeline, so unlike the top-level payload there is no
    per-output contributing walk to narrow it."""
    wired = _wired_ports(graph)
    nodes = [n for n in graph.get("nodes", []) if "id" in n]
    nodes.sort(key=lambda n: str(n.get("id")))
    return {
        "nodes": [_node_for_hash(n, wired) for n in nodes],
        "edges": [e for e in graph.get("edges", []) if e.get("targetPort") != LOOSE_PORT],
        "signals": _referenced_signal_defs(graph, signals_by_id),
    }


def _composition_refs_payload(graph: dict, pool: dict | None, signals_by_id: dict):
    """`(payload, has_lyrics)` for the compositions reachable from `graph`'s montage
    extracts, or `(None, False)` when it references none — the key must be ABSENT in
    that case so every pre-pool graph keeps its exact hash (no RENDER_VERSION bump
    for plumbing). Child signal defs resolve against the HOST segment's signals:
    the contextual time base (specs/compositions decision 1) renders a shared child
    under the referencing segment's signals, so those are what shape its frames."""
    from .compositions import composition_closure, final_output_id, referenced_composition_ids

    seeds = referenced_composition_ids(graph)
    if not seeds:
        return None, False
    payload = []
    has_lyrics = False
    for cid, comp in composition_closure(pool, seeds):
        if comp is None:
            payload.append([cid, None])  # dangling — still moves the key
            continue
        g = comp.get("graph") or {}
        has_lyrics = has_lyrics or any(n.get("type") == "lyrics" for n in g.get("nodes", []))
        payload.append([cid, final_output_id(comp), _graph_for_hash(g, signals_by_id)])
    return payload, has_lyrics


def output_hash(
    job_id: str,
    segment: dict,
    graph: dict,
    output_id: str,
    output: dict | None = None,
    pool: dict | None = None,
) -> str:
    """Stable SHA-1 over ONE output's CONTRIBUTING video DAG (spec 10).

    Covers every node upstream of `output_id` (fluids, combines, output
    pass-throughs, value/signal nodes), the edges among them, their referenced
    signal defs, the segment bounds + job id, and the project `output` settings —
    so each output caches independently and editing one pipeline never busts
    another's. Excludes node positions/view.

    When the contributing DAG holds a montage with extracts, `pool` (the project's
    composition pool) contributes the RECURSIVE closure of referenced compositions
    — editing a child composition anywhere in the tree moves the root's key, while
    editing an unreferenced composition moves nothing.
    """
    contributing = _contributing_ids(graph, output_id)
    nodes = {n["id"]: n for n in graph.get("nodes", []) if "id" in n}
    sub_nodes = [nodes[i] for i in sorted(contributing) if i in nodes]
    signals_by_id = {s["id"]: s for s in segment.get("signals", []) if "id" in s}
    wired = _wired_ports(graph)  # hoisted: one pass over the edges, not one per node
    payload = {
        "render_version": RENDER_VERSION,
        "job_id": job_id,
        "output_id": output_id,
        "start": float(segment.get("start", 0.0)),
        "end": float(segment.get("end", 0.0)),
        "nodes": [_node_for_hash(n, wired) for n in sub_nodes],
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
    refs, refs_have_lyrics = _composition_refs_payload(
        {"nodes": sub_nodes, "edges": graph.get("edges", [])}, pool, signals_by_id
    )
    if refs is not None:
        payload["compositions"] = refs
    # A lyrics card burns external (segment) lyric text into the frames; fold the lines
    # overlapping this segment into the hash so editing the lyrics busts the cache. A
    # lyrics card inside a REFERENCED composition burns the same segment lines.
    if refs_have_lyrics or any(n.get("type") == "lyrics" for n in sub_nodes):
        s, e = float(segment.get("start", 0.0)), float(segment.get("end", 0.0))
        payload["lyrics"] = [
            [round(float(ln.get("t0", 0)), 2), round(float(ln.get("t1", 0)), 2), ln.get("text", "")]
            for ln in (segment.get("lyric_lines") or [])
            if float(ln.get("t1", 0)) > s and float(ln.get("t0", 0)) < e
        ]
    blob = json.dumps(payload, sort_keys=True, default=str).encode()
    return hashlib.sha1(blob).hexdigest()[:16]
