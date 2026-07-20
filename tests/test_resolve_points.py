"""resolve_node_points: the points twin of resolve_node_curve — resolves a points
node's base positions for the card preview (no render)."""

from backend import graph as G

from helpers import no_audio as NOAUDIO

SEG = {"start": 0.0, "end": 1.0, "signals": []}


def _edge(s, t, tp):
    return {"id": f"{s}-{t}-{tp}", "source": s, "sourcePort": "out", "target": t, "targetPort": tp}


def test_resolves_a_pattern_layout_to_its_points():
    g = {
        "version": 19,
        "nodes": [
            {
                "id": "p",
                "type": "pattern",
                "data": {
                    "layout": "circle",
                    "count": 6,
                    "radius": 0.3,
                    "rotation": 0,
                    "seed": 1,
                    "offsetX": 0,
                    "offsetY": 0,
                },
            },
        ],
        "edges": [],
    }
    out = G.resolve_node_points("job", SEG, g, "p", NOAUDIO)
    assert len(out["points"]) == 6
    for x, y in out["points"]:
        assert 0.0 <= x <= 1.0 and 0.0 <= y <= 1.0


def test_merge_points_concatenates_its_wired_inputs():
    g = {
        "version": 19,
        "nodes": [
            {"id": "a", "type": "points", "data": {"points": [[0.1, 0.1], [0.2, 0.2]]}},
            {"id": "b", "type": "points", "data": {"points": [[0.8, 0.8]]}},
            {"id": "m", "type": "merge-points", "data": {"inputs": ["i1", "i2"]}},
        ],
        "edges": [_edge("a", "m", "i1"), _edge("b", "m", "i2")],
    }
    out = G.resolve_node_points("job", SEG, g, "m", NOAUDIO)
    assert len(out["points"]) == 3  # 2 + 1 merged


def test_unknown_or_unwired_node_resolves_to_no_points():
    g = {
        "version": 19,
        "nodes": [
            {"id": "m", "type": "merge-points", "data": {"inputs": ["i1"]}},
        ],
        "edges": [],
    }
    out = G.resolve_node_points("job", SEG, g, "m", NOAUDIO)
    assert out["points"] == []
