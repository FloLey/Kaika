"""Graph validation (01 §3.7): raise ValueError (surfaced as HTTP 400) on a graph
that isn't renderable, so a malformed graph fails at the boundary rather than deep
inside a render."""

from __future__ import annotations

from .graph_common import (
    _PORT_SPECS,
    LOOSE_PORT,
    VIDEO_PRODUCERS,
    _is_emitter_source,
    _nodes_of,
    _video_source,
)


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


def _check_outputs(graph: dict, nodes: dict, output_id: str | None) -> None:
    """At least one output, each wired to exactly one video producer via its `video` port.

    Skipped entirely when `output_id` names a PRODUCER rather than an output node: per the
    `_render_target` contract that is a card previewing itself, so a graph mid-build (first
    card dropped, nothing wired) previews fine and an unrelated half-wired output can't
    400 it. The frontend mirror is `nodeRenderable` (lib/graph/validate.ts).
    """
    target = nodes.get(output_id) if output_id else None
    if target is not None and target.get("type") != "output":  # previewing a producer
        if target.get("type") not in VIDEO_PRODUCERS:
            raise ValueError(f"node '{output_id}' is not a video producer")
        return

    outputs = _nodes_of(graph, "output")
    if len(outputs) < 1:
        raise ValueError("graph must have at least one output node")
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
        if src is None or src.get("type") not in VIDEO_PRODUCERS:
            raise ValueError(
                f"output '{out['id']}' must be wired to a video producer "
                f"(fluid / combine / an FX or source card)"
            )


def _check_bindings(graph: dict, nodes: dict) -> None:
    """Every modulatable port binding is well-formed (fluid + FX + source cards)."""
    for node in graph.get("nodes", []):
        if node.get("type") == "fluid" or node.get("type") in _PORT_SPECS:
            for key, port in node.get("data", {}).get("ports", {}).items():
                _validate_binding(key, (port or {}).get("binding") or {}, nodes)


def _check_slot_ids(combines: list, montages: list) -> None:
    """Every combine/montage input slot carries an id — the targetPort a video edge
    wires to. An id-less slot is invisible to the renderer AND to the hash."""
    for card in (*combines, *montages):
        for slot in card.get("data", {}).get("inputs", []):
            if not slot.get("id"):
                raise ValueError(f"{card['type']} '{card['id']}' has an input slot with no id")


def _check_montage_exclusivity(graph: dict, nodes: dict, montages: list) -> None:
    """Each montage slot's upstream chain is EXCLUSIVE to that slot.

    Block streaming memoizes ONE producer per node and the montage pulls it with
    slot-local frame ranges (graph_render._montage_block), so a card feeding a montage
    slot AND any other consumer would receive conflicting ranges — reject with a clear
    message instead of corrupting a stateful sim mid-stream. (Value bindings are exempt:
    curves resolve purely, full-segment.)
    """
    if not montages:
        return
    # Video-flow edges: a video producer's output is only ever consumed as video, so any
    # non-loose edge whose SOURCE is a producer-typed node qualifies.
    vid_edges = [
        e
        for e in graph.get("edges", [])
        if e.get("targetPort") != LOOSE_PORT
        and nodes.get(e.get("source"), {}).get("type") in VIDEO_PRODUCERS
    ]
    back: dict[str, list[str]] = {}
    for e in vid_edges:
        back.setdefault(e["target"], []).append(e["source"])
    for mg in montages:
        for slot in mg.get("data", {}).get("inputs", []):
            src = _video_source(graph, mg["id"], slot.get("id"))
            if src is None:
                continue
            closure: set = set()
            stack = [src]
            while stack:
                n = stack.pop()
                if n not in closure:
                    closure.add(n)
                    stack.extend(back.get(n, ()))
            for e in vid_edges:
                if e.get("source") not in closure:
                    continue
                is_slot_edge = (
                    e["source"] == src
                    and e.get("target") == mg["id"]
                    and e.get("targetPort") == slot.get("id")
                )
                if not is_slot_edge and e.get("target") not in closure:
                    bad = nodes.get(e["source"], {}).get("type", "?")
                    raise ValueError(
                        f"the '{bad}' card feeding a montage slot also feeds another "
                        f"consumer — a montage re-times its inputs, so each slot's "
                        f"chain must be exclusive to it; duplicate the card instead"
                    )


def _check_merge_sources(graph: dict, nodes: dict, combines: list) -> None:
    """A merge combine's inputs resolve to fluid emitters — a composited video (a layered
    combine, or a video source like lyrics) has no single emitter set."""
    for cb in combines:
        if cb.get("data", {}).get("mode") != "merge":
            continue
        for slot in cb.get("data", {}).get("inputs", []):
            src = _video_source(graph, cb["id"], slot.get("id"))
            if src is not None and not _is_emitter_source(graph, src, nodes):
                bad = nodes.get(src, {}).get("type", "?")
                raise ValueError(
                    f"a merge combine only accepts fluid sources, but a '{bad}' card is "
                    f"wired into it — switch the combine to 'layered' to overlay it"
                )


def _check_acyclic(graph: dict, nodes: dict) -> None:
    """Acyclic over ALL edges (value bindings + video). Loose (parked) wires feed
    nothing, so they can't form a real cycle and are filtered out."""
    adj: dict[str, list[str]] = {nid: [] for nid in nodes}
    for e in graph.get("edges", []):
        if e.get("targetPort") == LOOSE_PORT:
            continue
        if e.get("target") in adj and e.get("source") in nodes:
            adj[e["target"]].append(e["source"])
    if _has_cycle(adj):
        raise ValueError("graph contains a cycle")


def validate(graph: dict, output_id: str | None = None) -> None:
    """Raise ValueError (surfaced as HTTP 400) if the graph is not renderable.

    Six independent rules, one function each — see them for the reasoning. They ran as
    one 130-line body (ruff C901 35, the worst in the repo); each is unchanged here, only
    named. Order is preserved: the cheap structural checks fail before the graph walks.

    `output_id` names the render TARGET, which may be an output node OR any video
    producer directly (a card previewing itself) — see `_check_outputs`.
    """
    if not isinstance(graph, dict):
        raise ValueError("graph must be an object")
    nodes = {n["id"]: n for n in graph.get("nodes", []) if "id" in n}
    # Walked twice before — once for slot ids, once for merge sources.
    combines = _nodes_of(graph, "combine")
    montages = _nodes_of(graph, "montage")

    _check_outputs(graph, nodes, output_id)
    _check_bindings(graph, nodes)
    _check_slot_ids(combines, montages)
    _check_montage_exclusivity(graph, nodes, montages)
    _check_merge_sources(graph, nodes, combines)
    _check_acyclic(graph, nodes)


def validate_pool(pool: dict | None) -> None:
    """Pool-level validation (specs/compositions): the composition-REFERENCE graph
    (montage extracts pointing at child compositions) must be acyclic — a
    composition containing itself, directly or transitively, would recurse forever
    at render time. Raises ValueError (HTTP 400 at the boundary).

    Deliberately does NOT run `validate()` on every entry: rendering composition A
    must not fail because composition B is mid-edit (a just-created leaf with
    nothing wired). Each composition is fully validated when IT renders."""
    from .compositions import referenced_composition_ids

    if pool is None:
        return
    if not isinstance(pool, dict):
        raise ValueError("compositions must be an object keyed by composition id")
    adj: dict[str, list[str]] = {}
    for cid, comp in pool.items():
        if not isinstance(comp, dict) or not isinstance(comp.get("graph"), dict):
            raise ValueError(f"composition '{cid}' has no graph")
        # Dangling references (id not in the pool) can't close a cycle — skip them.
        adj[cid] = [r for r in referenced_composition_ids(comp["graph"]) if r in pool]
    if _has_cycle(adj):
        raise ValueError("compositions reference each other in a cycle")


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
