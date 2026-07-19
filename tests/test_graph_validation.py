"""Strict graph validation (Phase 7): malformed bindings / combine slots are
rejected at the boundary instead of crashing later in build_params."""

import pytest

from backend import graph


def _fluid(ports=None):
    return {
        "id": "n-f",
        "type": "fluid",
        "x": 0,
        "y": 0,
        "data": {"static": {}, "ports": ports or {}},
    }


def _g(fluid_ports=None, extra_nodes=None):
    nodes = [_fluid(fluid_ports), {"id": "n-o", "type": "output", "x": 0, "y": 0, "data": {}}]
    nodes += extra_nodes or []
    edges = [
        {"id": "e", "source": "n-f", "sourcePort": "out", "target": "n-o", "targetPort": "video"}
    ]
    return {"version": 2, "nodes": nodes, "edges": edges}


def test_accepts_a_wellformed_graph():
    graph.validate(_g({"force": {"binding": {"kind": "const", "value": 20.0}}}))  # no raise


def test_rejects_non_numeric_const_value():
    with pytest.raises(ValueError, match="non-numeric value"):
        graph.validate(_g({"force": {"binding": {"kind": "const", "value": "loud"}}}))


def test_rejects_unknown_binding_kind():
    with pytest.raises(ValueError, match="unknown binding kind"):
        graph.validate(_g({"force": {"binding": {"kind": "weird"}}}))


def test_rejects_node_binding_to_missing_node():
    with pytest.raises(ValueError, match="unknown node"):
        graph.validate(
            _g({"force": {"binding": {"kind": "node", "nodeId": "ghost", "lo": 0, "hi": 1}}})
        )


def test_rejects_non_numeric_lo_hi():
    sig = {"id": "n-s", "type": "signal", "x": 0, "y": 0, "data": {"signalId": "s"}}
    with pytest.raises(ValueError, match="non-numeric"):
        graph.validate(
            _g(
                {"force": {"binding": {"kind": "node", "nodeId": "n-s", "lo": "x", "hi": 1}}},
                extra_nodes=[sig],
            )
        )


def test_rejects_combine_slot_without_id():
    combine = {
        "id": "n-c",
        "type": "combine",
        "x": 0,
        "y": 0,
        "data": {"mode": "merge", "inputs": [{"opacity": 1}], "medium": {}},
    }
    with pytest.raises(ValueError, match="slot with no id"):
        graph.validate(_g(extra_nodes=[combine]))


# --------------------------------------------------------------------------- #
# Direct producer previews (the `_render_target` contract): `output_id` may name any
# video producer, not just an output node. A card previewing itself must not require an
# output node to exist — a graph mid-build (first card dropped, nothing wired yet) has
# none — nor be blocked by an unrelated, still-unwired output.
# --------------------------------------------------------------------------- #
def _producer_only():
    return {"version": 21, "nodes": [_fluid()], "edges": []}


def test_previewing_a_producer_needs_no_output_node():
    graph.validate(_producer_only(), "n-f")  # no raise


def test_previewing_a_producer_ignores_a_half_wired_output():
    g = _producer_only()
    g["nodes"].append({"id": "n-o", "type": "output", "x": 0, "y": 0, "data": {}})
    graph.validate(g, "n-f")  # the unwired output belongs to another pipeline


def test_no_target_still_requires_an_output_node():
    with pytest.raises(ValueError, match="at least one output node"):
        graph.validate(_producer_only())


def test_targeting_an_output_still_enforces_the_output_rules():
    g = _g()
    g["nodes"].append({"id": "n-o2", "type": "output", "x": 0, "y": 0, "data": {}})
    with pytest.raises(ValueError, match="exactly one source"):
        graph.validate(g, "n-o")


def test_previewing_a_non_producer_is_rejected():
    g = _producer_only()
    g["nodes"].append({"id": "n-l", "type": "lfo", "x": 0, "y": 0, "data": {}})
    with pytest.raises(ValueError, match="not a video producer"):
        graph.validate(g, "n-l")


# --------------------------------------------------------------------------- #
# One case per rule `validate` enforces. Cleanup step 10 splits that 130-line
# function (C901 = 35, the worst in the repo) into six named checks, and validation
# fails OPEN: a rule dropped in the split doesn't throw, the graph just renders
# wrongly. Nothing goes red unless each rule is pinned individually first.
#
# Rules covered above: outputs (exists / exactly one source / is a producer),
# bindings (4 cases), combine slot ids. Covered in test_montage.py: montage slot
# exclusivity. The two below had NO test anywhere.
# --------------------------------------------------------------------------- #
def test_rejects_a_non_dict_graph():
    with pytest.raises(ValueError, match="graph must be an object"):
        graph.validate([])


def test_rejects_an_output_wired_to_a_non_producer():
    """An output fed by a modulator card, not a video card."""
    g = _g()
    g["nodes"].append({"id": "n-lfo", "type": "lfo", "x": 0, "y": 0, "data": {}})
    g["edges"] = [
        {"id": "e", "source": "n-lfo", "sourcePort": "out", "target": "n-o", "targetPort": "video"}
    ]
    with pytest.raises(ValueError, match="must be wired to a video producer"):
        graph.validate(g)


def test_rejects_montage_slot_without_id():
    montage = {
        "id": "n-m",
        "type": "montage",
        "x": 0,
        "y": 0,
        "data": {"inputs": [{"opacity": 1}]},
    }
    with pytest.raises(ValueError, match="slot with no id"):
        graph.validate(_g(extra_nodes=[montage]))


def test_rejects_a_merge_combine_fed_by_a_non_emitter():
    """A merge combine composites EMITTERS, so it needs raw fluid sources. A video card
    (here lyrics) has no single emitter set — the message tells you to switch to
    'layered' instead. This rule had no test."""
    nodes = [
        {"id": "n-l", "type": "lyrics", "x": 0, "y": 0, "data": {"ports": {}}},
        {
            "id": "n-c",
            "type": "combine",
            "x": 0,
            "y": 0,
            "data": {"mode": "merge", "inputs": [{"id": "s0", "opacity": 1}], "medium": {}},
        },
        {"id": "n-o", "type": "output", "x": 0, "y": 0, "data": {}},
    ]
    edges = [
        {"id": "e1", "source": "n-l", "sourcePort": "out", "target": "n-c", "targetPort": "s0"},
        {"id": "e2", "source": "n-c", "sourcePort": "out", "target": "n-o", "targetPort": "video"},
    ]
    g = {"version": 2, "nodes": nodes, "edges": edges}
    with pytest.raises(ValueError, match="merge combine only accepts fluid sources"):
        graph.validate(g)


def test_accepts_a_layered_combine_fed_by_a_video_card():
    """The same graph in 'layered' mode is legal — the rule is about merge only, so the
    split must not over-apply it."""
    nodes = [
        {"id": "n-l", "type": "lyrics", "x": 0, "y": 0, "data": {"ports": {}}},
        {
            "id": "n-c",
            "type": "combine",
            "x": 0,
            "y": 0,
            "data": {"mode": "layered", "inputs": [{"id": "s0", "opacity": 1}], "medium": {}},
        },
        {"id": "n-o", "type": "output", "x": 0, "y": 0, "data": {}},
    ]
    edges = [
        {"id": "e1", "source": "n-l", "sourcePort": "out", "target": "n-c", "targetPort": "s0"},
        {"id": "e2", "source": "n-c", "sourcePort": "out", "target": "n-o", "targetPort": "video"},
    ]
    graph.validate({"version": 2, "nodes": nodes, "edges": edges})  # no raise


def test_rejects_a_cycle():
    """Acyclic over ALL edges (value bindings + video). This rule had no test, and a
    cycle reaches the render as unbounded recursion rather than a 400."""
    g = _g()
    # the output feeds a fluid port back — legal shapes on both ends, a loop together
    g["edges"].append(
        {"id": "e2", "source": "n-o", "sourcePort": "out", "target": "n-f", "targetPort": "force"}
    )
    with pytest.raises(ValueError, match="cycle"):
        graph.validate(g)


def test_a_loose_wire_cannot_form_a_cycle():
    """Parked wires (`targetPort: "__in"`, no binding) feed nothing, so they must be
    filtered out of the cycle walk — a hard invariant per CLAUDE.md."""
    g = _g()
    g["edges"].append(
        {"id": "e2", "source": "n-o", "sourcePort": "out", "target": "n-f", "targetPort": "__in"}
    )
    graph.validate(g)  # no raise: the loose edge is not a real dependency
