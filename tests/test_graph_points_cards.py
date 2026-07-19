"""Unit tests for the points cards — pattern / animate-points.

Exercise the layout/transform helpers and their integration: a points pipeline wired
into a fluid's `positions` resolves to one emitter per point. Run with
``.venv/bin/python -m pytest``.
"""

from backend import graph


def test_pattern_circle_count_and_bounds():
    pts = graph._pattern_points({"layout": "circle", "count": 8, "radius": 0.3, "rotation": 0})
    assert len(pts) == 8
    assert all(0.0 <= x <= 1.0 and 0.0 <= y <= 1.0 for x, y in pts)


def test_pattern_count_is_capped():
    pts = graph._pattern_points({"layout": "ring", "count": 999, "radius": 0.3})
    assert len(pts) == graph._POINT_CAP


def test_pattern_scatter_is_seeded():
    a = graph._pattern_points({"layout": "scatter", "count": 10, "radius": 0.4, "seed": 5})
    b = graph._pattern_points({"layout": "scatter", "count": 10, "radius": 0.4, "seed": 5})
    c = graph._pattern_points({"layout": "scatter", "count": 10, "radius": 0.4, "seed": 6})
    assert a == b and a != c


def test_animate_orbit_and_drift_produce_paths():
    specs = [graph._static_point_spec((0.6, 0.5))]
    orbit = graph._animate_point_specs(specs, {"mode": "orbit", "amount": 0.2, "rate": 1})
    assert len(orbit[0]["points"]) > 2 and orbit[0]["path_closed"]
    drift = graph._animate_point_specs(
        specs, {"mode": "drift", "amount": 0.2, "rate": 2, "angle": 90}
    )
    assert len(drift[0]["points"]) == 2 and drift[0]["path_pingpong"]


def test_animate_chase_gates_each_point():
    specs = [graph._static_point_spec(p) for p in ((0.3, 0.5), (0.5, 0.5), (0.7, 0.5), (0.9, 0.5))]
    out = graph._animate_point_specs(specs, {"mode": "chase", "count": 1, "rate": 2, "fade": 0.1})
    assert len(out) == 4
    # positions are preserved (chase keeps the points fixed) ...
    assert [o["points"] for o in out] == [s["points"] for s in specs]
    # ... and each carries gate fields: phase = slot, duty = count/n, speed = rate.
    assert [o["gate_phase"] for o in out] == [0.0, 0.25, 0.5, 0.75]
    assert all(
        o["gate_duty"] == 0.25 and o["gate_speed"] == 2 and o["gate_fade"] == 0.1 for o in out
    )


def test_animate_chase_count_clamped_to_point_count():
    specs = [graph._static_point_spec((0.5, 0.5))] * 3
    out = graph._animate_point_specs(specs, {"mode": "chase", "count": 99, "rate": 1})
    assert all(o["gate_duty"] == 1.0 for o in out)  # count >= n -> everything lit


def test_pattern_into_fluid_positions_yields_one_emitter_per_point():
    seg = {"start": 0.0, "end": 2.0, "signals": []}
    g = {
        "version": 4,
        "nodes": [
            {
                "id": "p1",
                "type": "pattern",
                "x": 0,
                "y": 0,
                "data": {"layout": "ring", "count": 8, "radius": 0.3},
            },
            {
                "id": "f1",
                "type": "fluid",
                "x": 0,
                "y": 0,
                "data": {"static": {"color": [0.3, 0.7, 1.0]}, "ports": {}},
            },
            {"id": "o1", "type": "output", "x": 0, "y": 0, "data": {"title": "p"}},
        ],
        "edges": [
            {
                "id": "e1",
                "source": "p1",
                "sourcePort": "out",
                "target": "f1",
                "targetPort": "positions",
            },
            {
                "id": "e2",
                "source": "f1",
                "sourcePort": "out",
                "target": "o1",
                "targetPort": "video",
            },
        ],
    }
    graph.validate(g)  # no raise
    dag = graph.Dag("job", seg, g, lambda j, s: None, {"fps": 24, "width": 128, "height": 128})
    emitters = dag._fluid_emitters(g["nodes"][1])
    assert len(emitters) == 8
    assert all("points" in e and "color" in e for e in emitters)


def test_chained_points_pipeline_resolves():
    # pattern -> animate -> fluid.positions, all the way through.
    seg = {"start": 0.0, "end": 2.0, "signals": []}
    g = {
        "version": 4,
        "nodes": [
            {
                "id": "p1",
                "type": "pattern",
                "x": 0,
                "y": 0,
                "data": {"layout": "line", "count": 3, "radius": 0.3},
            },
            {
                "id": "a1",
                "type": "animate-points",
                "x": 0,
                "y": 0,
                "data": {"mode": "orbit", "amount": 0.2, "rate": 1},
            },
            {
                "id": "f1",
                "type": "fluid",
                "x": 0,
                "y": 0,
                "data": {"static": {"color": [0.3, 0.7, 1.0]}, "ports": {}},
            },
            {"id": "o1", "type": "output", "x": 0, "y": 0, "data": {"title": "p"}},
        ],
        "edges": [
            {"id": "e1", "source": "p1", "sourcePort": "out", "target": "a1", "targetPort": "in"},
            {
                "id": "e2",
                "source": "a1",
                "sourcePort": "out",
                "target": "f1",
                "targetPort": "positions",
            },
            {
                "id": "e3",
                "source": "f1",
                "sourcePort": "out",
                "target": "o1",
                "targetPort": "video",
            },
        ],
    }
    graph.validate(g)
    dag = graph.Dag("job", seg, g, lambda j, s: None, {"fps": 24, "width": 128, "height": 128})
    emitters = dag._fluid_emitters(g["nodes"][2])
    # 3 points, each animated into an orbit path
    assert len(emitters) == 3
    assert all(e.get("path_closed") for e in emitters)
