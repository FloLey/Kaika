"""Strict graph validation (Phase 7): malformed bindings / combine slots are
rejected at the boundary instead of crashing later in build_params."""
import pytest

from backend import graph


def _fluid(ports=None):
    return {"id": "n-f", "type": "fluid", "x": 0, "y": 0,
            "data": {"static": {}, "ports": ports or {}}}


def _g(fluid_ports=None, extra_nodes=None):
    nodes = [_fluid(fluid_ports), {"id": "n-o", "type": "output", "x": 0, "y": 0, "data": {}}]
    nodes += extra_nodes or []
    edges = [{"id": "e", "source": "n-f", "sourcePort": "out", "target": "n-o", "targetPort": "video"}]
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
        graph.validate(_g({"force": {"binding": {"kind": "node", "nodeId": "ghost", "lo": 0, "hi": 1}}}))


def test_rejects_non_numeric_lo_hi():
    sig = {"id": "n-s", "type": "signal", "x": 0, "y": 0, "data": {"signalId": "s"}}
    with pytest.raises(ValueError, match="non-numeric"):
        graph.validate(_g(
            {"force": {"binding": {"kind": "node", "nodeId": "n-s", "lo": "x", "hi": 1}}},
            extra_nodes=[sig],
        ))


def test_rejects_combine_slot_without_id():
    combine = {"id": "n-c", "type": "combine", "x": 0, "y": 0,
               "data": {"mode": "merge", "inputs": [{"opacity": 1}], "medium": {}}}
    with pytest.raises(ValueError, match="slot with no id"):
        graph.validate(_g(extra_nodes=[combine]))
