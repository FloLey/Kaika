"""Graph validation (01 §3.7): raise ValueError (surfaced as HTTP 400) on a graph
that isn't renderable, so a malformed graph fails at the boundary rather than deep
inside a render."""

from __future__ import annotations

from .graph_common import _PORT_SPECS, LOOSE_PORT, _is_emitter_source, _nodes_of, _video_source


def _video_producers() -> tuple:
    # Lazy: the producer set derives from graph_render's handler registry, and
    # graph_render imports this module — resolving it at call time breaks the cycle.
    from .graph_render import _VIDEO_PRODUCERS

    return _VIDEO_PRODUCERS


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


def validate(graph: dict, output_id: str | None = None) -> None:
    """Raise ValueError (surfaced as HTTP 400) if the graph is not renderable.

    Rules: at least one output, each output wired to exactly one fluid, every fluid
    port binding well-formed (const numeric / node resolves to an existing node),
    combine slots carry ids, and the binding graph is acyclic. N independent
    fluid->output pipelines are allowed.

    `output_id` names the render TARGET. Per the `_render_target` contract it may be an
    output node **or any video producer directly** — that's how a fluid / combine /
    transform card renders its own live preview. When it names a producer, the
    output-node rules don't apply: a graph mid-build (a fluid card dropped, no output
    wired yet) previews fine, and an unrelated half-wired output can't 400 it. The
    frontend mirror is `nodeRenderable` (lib/graph/validate.ts).
    """
    if not isinstance(graph, dict):
        raise ValueError("graph must be an object")
    nodes = {n["id"]: n for n in graph.get("nodes", []) if "id" in n}

    target = nodes.get(output_id) if output_id else None
    previewing_producer = target is not None and target.get("type") != "output"

    if not previewing_producer:
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
            if src is None or src.get("type") not in _video_producers():
                raise ValueError(
                    f"output '{out['id']}' must be wired to a video producer "
                    f"(fluid / combine / an FX or source card)"
                )
    elif target.get("type") not in _video_producers():
        raise ValueError(f"node '{output_id}' is not a video producer")

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

    # Montage: every input slot carries an id, and each slot's upstream chain is
    # EXCLUSIVE to that slot. Block streaming memoizes ONE producer per node and the
    # montage pulls it with slot-local frame ranges (graph_render._montage_block), so
    # a card feeding a montage slot AND any other consumer would receive conflicting
    # ranges — reject with a clear message instead of corrupting a stateful sim
    # mid-stream. (Value bindings are exempt: curves resolve purely, full-segment.)
    montages = _nodes_of(graph, "montage")
    for mg in montages:
        for slot in mg.get("data", {}).get("inputs", []):
            if not slot.get("id"):
                raise ValueError(f"montage '{mg['id']}' has an input slot with no id")
    if montages:
        producers = _video_producers()
        # Video-flow edges: a video producer's output is only ever consumed as video,
        # so any non-loose edge whose SOURCE is a producer-typed node qualifies.
        vid_edges = [
            e
            for e in graph.get("edges", [])
            if e.get("targetPort") != LOOSE_PORT
            and nodes.get(e.get("source"), {}).get("type") in producers
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
        if e.get("targetPort") == LOOSE_PORT:
            continue  # loose (unassigned) wires feed nothing — can't form a real cycle
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
