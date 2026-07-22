"""Pool-aware hashing + validation (compositions wave, step 02).

The contract: `output_hash` folds the RECURSIVE closure of compositions a montage's
extracts reference — editing a child (any depth) moves the root's key, editing an
unreferenced composition moves nothing, and a graph with no references keys exactly
as it did before the pool existed (no RENDER_VERSION bump for plumbing).
`validate_pool` refuses reference cycles at the boundary.
"""

from __future__ import annotations

import pytest

from backend import graph as G
from backend.graph_common import resolve_signal

OUT = {"width": 96, "height": 128, "quality": "draft", "fps": 24}
SEG = {"id": "s1", "start": 0.0, "end": 4.0, "signals": []}


def _backdrop_graph(color="#204080"):
    return {
        "version": 1,
        "nodes": [
            {"id": "b", "type": "backdrop", "data": {"color": color, "ports": {}}},
            {"id": "o", "type": "output", "data": {}},
        ],
        "edges": [
            {"id": "e", "source": "b", "sourcePort": "out", "target": "o", "targetPort": "video"}
        ],
    }


def _montage_graph(*comp_ids):
    """A root graph: montage (with one extract per referenced composition) -> output."""
    return {
        "version": 1,
        "nodes": [
            {
                "id": "mg",
                "type": "montage",
                "data": {
                    "extracts": [
                        {"id": f"x{i}", "compositionId": cid} for i, cid in enumerate(comp_ids)
                    ],
                    "manualBreakpoints": [],
                    "disabledCuts": [],
                    "threshold": 0.5,
                    "hysteresis": 0.1,
                    "ports": {},
                },
            },
            {"id": "o", "type": "output", "data": {}},
        ],
        "edges": [
            {"id": "e", "source": "mg", "sourcePort": "out", "target": "o", "targetPort": "video"}
        ],
    }


def _comp(cid, graph, output_id=None):
    return {
        "id": cid,
        "name": cid,
        "graph": graph,
        **({"outputId": output_id} if output_id else {}),
    }


def _h(graph, pool=None):
    return G.output_hash("job", SEG, graph, "o", OUT, pool)


# ── hash stability & sensitivity ─────────────────────────────────────────────


def test_pool_arg_is_invisible_to_a_graph_with_no_references():
    """Threading the pool through must not move a single existing cache key."""
    g = _backdrop_graph()
    assert _h(g) == _h(g, {}) == _h(g, {"c1": _comp("c1", _backdrop_graph("#ff0000"))})


def test_editing_a_referenced_child_busts_the_root():
    g = _montage_graph("c1")
    base = _h(g, {"c1": _comp("c1", _backdrop_graph())})
    edited = _h(g, {"c1": _comp("c1", _backdrop_graph("#3a7f2b"))})
    assert base != edited


def test_editing_an_unreferenced_composition_moves_nothing():
    g = _montage_graph("c1")
    pool = {"c1": _comp("c1", _backdrop_graph()), "cX": _comp("cX", _backdrop_graph())}
    edited = {**pool, "cX": _comp("cX", _backdrop_graph("#3a7f2b"))}
    assert _h(g, pool) == _h(g, edited)


def test_a_grandchild_edit_reaches_the_root_key():
    """Depth 2: root -> c1 (a montage itself) -> c2. Editing c2 moves the root."""
    g = _montage_graph("c1")
    pool = {
        "c1": _comp("c1", _montage_graph("c2")),
        "c2": _comp("c2", _backdrop_graph()),
    }
    edited = {**pool, "c2": _comp("c2", _backdrop_graph("#3a7f2b"))}
    assert _h(g, pool) != _h(g, edited)


def test_a_dangling_reference_still_changes_the_key():
    """A reference appearing (even unresolvable) is a content change."""
    assert _h(_montage_graph(), {}) != _h(_montage_graph("c-gone"), {})


def test_child_output_mark_moves_the_key():
    two_outs = _backdrop_graph()
    two_outs["nodes"].append({"id": "o2", "type": "output", "data": {}})
    two_outs["edges"].append(
        {"id": "e2", "source": "b", "sourcePort": "out", "target": "o2", "targetPort": "video"}
    )
    g = _montage_graph("c1")
    assert _h(g, {"c1": _comp("c1", two_outs, "o")}) != _h(g, {"c1": _comp("c1", two_outs, "o2")})


# ── pool validation ──────────────────────────────────────────────────────────


def test_validate_pool_accepts_a_dag_and_dangling_refs():
    G.validate_pool(None)
    G.validate_pool({})
    G.validate_pool(
        {
            "c1": _comp("c1", _montage_graph("c2", "c-gone")),  # dangling ref is fine
            "c2": _comp("c2", _backdrop_graph()),
        }
    )


def test_validate_pool_refuses_a_cycle():
    with pytest.raises(ValueError, match="cycle"):
        G.validate_pool(
            {
                "c1": _comp("c1", _montage_graph("c2")),
                "c2": _comp("c2", _montage_graph("c1")),
            }
        )
    with pytest.raises(ValueError, match="cycle"):  # self-reference
        G.validate_pool({"c1": _comp("c1", _montage_graph("c1"))})


def test_validate_pool_refuses_a_graphless_entry():
    with pytest.raises(ValueError, match="no graph"):
        G.validate_pool({"c1": {"id": "c1", "name": "broken"}})


def test_stream_route_400s_on_a_pool_cycle(client):
    r = client.post(
        "/animate/stream",
        json={
            "job_id": "deadbeef",
            "segment": SEG,
            "graph": _montage_graph("c1"),
            "output_id": "o",
            "compositions": {
                "c1": _comp("c1", _montage_graph("c2")),
                "c2": _comp("c2", _montage_graph("c1")),
            },
        },
    )
    assert r.status_code == 400
    assert "cycle" in r.get_json()["error"]


# ── the signal signature fallback (SignalData.ref) ───────────────────────────


def _sig(sid, **over):
    return {
        "id": sid,
        "stemKey": "drums",
        "minHz": 40,
        "maxHz": 120,
        "feature": "energy",
        "attack": 5,
        "release": 250,
        **over,
    }


def test_resolve_signal_prefers_the_exact_id():
    sigs = {"sig-a": _sig("sig-a"), "sig-b": _sig("sig-b", minHz=200, maxHz=800)}
    node_data = {
        "signalId": "sig-b",
        "ref": {"stemKey": "drums", "minHz": 40, "maxHz": 120, "feature": "energy"},
    }
    assert resolve_signal(node_data, sigs)["id"] == "sig-b"


def test_resolve_signal_falls_back_to_the_ref_signature():
    """The shared-composition case: the id dangles (another segment's UUIDs), but the
    host has a signal with the same stem/band/feature — that one drives the child,
    shaping included."""
    sigs = {"sig-host": _sig("sig-host", release=120)}
    node_data = {
        "signalId": "sig-from-another-segment",
        "ref": {"stemKey": "drums", "minHz": 40, "maxHz": 120, "feature": "energy"},
    }
    assert resolve_signal(node_data, sigs)["id"] == "sig-host"
    # no ref, or no signature match -> None (renders flat 0)
    assert resolve_signal({"signalId": "nope"}, sigs) is None
    assert (
        resolve_signal(
            {
                "signalId": "nope",
                "ref": {"stemKey": "bass", "minHz": 40, "maxHz": 120, "feature": "energy"},
            },
            sigs,
        )
        is None
    )


def test_hash_covers_the_signature_matched_signal():
    """`_referenced_signal_defs` resolves like the render: when a child's signal node
    matches by signature, editing THAT host signal's shaping must move the key."""
    child = {
        "version": 1,
        "nodes": [
            {
                "id": "sg",
                "type": "signal",
                "data": {
                    "signalId": "dangling",
                    "ref": {"stemKey": "drums", "minHz": 40, "maxHz": 120, "feature": "energy"},
                },
            },
            {"id": "b", "type": "backdrop", "data": {"color": "#204080", "ports": {}}},
            {"id": "o", "type": "output", "data": {}},
        ],
        "edges": [
            {"id": "e", "source": "b", "sourcePort": "out", "target": "o", "targetPort": "video"}
        ],
    }
    g = _montage_graph("c1")
    pool = {"c1": _comp("c1", child)}
    seg_a = {**SEG, "signals": [_sig("sig-host", release=120)]}
    seg_b = {**SEG, "signals": [_sig("sig-host", release=900)]}  # shaping edit
    a = G.output_hash("job", seg_a, g, "o", OUT, pool)
    b = G.output_hash("job", seg_b, g, "o", OUT, pool)
    assert a != b
