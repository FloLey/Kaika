"""Backend contract for loose edges (the frontend's drop-anywhere `__in` wires):
they are UI parking state and must be invisible to validation, the contributing
walk, and the render-cache hash."""

from backend import graph as G

OUT = {"width": 64, "height": 64, "quality": "draft", "fps": 12}
SEG = {"start": 0.0, "end": 1.0, "signals": []}


def _graph(extra_edges=()):
    ports = {"emit": {"binding": {"kind": "const", "value": 0.4}}}
    return {
        "version": 14,
        "nodes": [
            {
                "id": "f",
                "type": "fluid",
                "data": {"static": {"points": [[0.5, 0.5]]}, "ports": ports},
            },
            {"id": "lfo", "type": "lfo", "data": {"shape": "sine"}},
            {"id": "o", "type": "output", "data": {}},
        ],
        "edges": [
            {"id": "e1", "source": "f", "sourcePort": "out", "target": "o", "targetPort": "video"},
            *extra_edges,
        ],
    }


LOOSE = {"id": "e-loose", "source": "lfo", "sourcePort": "out", "target": "f", "targetPort": "__in"}


def test_validate_ignores_loose_edges():
    G.validate(_graph([LOOSE]))  # must not raise


def test_loose_edge_cannot_form_a_fatal_cycle():
    # f -> o assigned; a loose wire o -> f would close a cycle IF counted. It isn't.
    back = {"id": "e-b", "source": "o", "sourcePort": "out", "target": "f", "targetPort": "__in"}
    G.validate(_graph([back]))  # must not raise


def test_output_hash_unchanged_by_loose_edges():
    h0 = G.output_hash("job", SEG, _graph(), "o", OUT)
    h1 = G.output_hash("job", SEG, _graph([LOOSE]), "o", OUT)
    assert h0 == h1
    # ...and the loose SOURCE node isn't pulled into the contributing set either.
    assert "lfo" not in G._contributing_ids(_graph([LOOSE]), "o")
