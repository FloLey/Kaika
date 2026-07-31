"""`backend/types.py` against the tables and fixtures that already enforce these shapes.

The types themselves enforce nothing: Python does not check a `TypedDict` at runtime and
this repo runs no static type checker, so an annotation there is documentation. This file
is what stops it from being documentation that quietly goes wrong.

Two anchors, and neither is a restatement of the types:

* `graph_hash._SIGNAL_HASH_FIELDS` — positional, hashed into every render key. If `Signal`
  and that tuple disagree, one of them is wrong about what affects the picture.
* `backend/playground_pipelines.json` — 35 real graphs, exported from the live UI by
  `make export-playground`. Checking node/edge/graph shapes against data the FRONTEND
  wrote is the point: these dicts cross a language boundary, and the frontend is the
  authority for them.

⚠ A failure here is not necessarily a bug in `types.py`. It means the two sides disagree;
read the diff before deciding which one moved.
"""

from __future__ import annotations

import json
from typing import get_type_hints

from backend import graph_hash, paths, types


def _keys(td) -> set[str]:
    return set(get_type_hints(td).keys())


def _fixture_graphs() -> list[dict]:
    raw = json.loads((paths.PROJECT_ROOT / "backend" / "playground_pipelines.json").read_text())
    out: list[dict] = []

    def walk(o):
        if isinstance(o, dict):
            if "nodes" in o and "edges" in o:
                out.append(o)
                return
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(raw)
    return out


# --------------------------------------------------------------------------- #
# Signal <-> the hash tuple
# --------------------------------------------------------------------------- #
def test_signal_fields_are_exactly_the_hash_fields_plus_identity():
    """Every `Signal` field either changes the picture (and is hashed) or identifies the
    signal to a human (`id`, `name`). There is no third category, and a field that landed
    in one place but not the other would silently break render caching in whichever
    direction it was missing."""
    identity = {"id", "name"}
    assert _keys(types.Signal) - identity == set(graph_hash._SIGNAL_HASH_FIELDS)


def test_hash_fields_are_all_declared_on_signal():
    """The other direction, stated separately so a failure says WHICH side gained a field:
    a hashed name that no longer exists on a signal hashes `None` for every project."""
    assert set(graph_hash._SIGNAL_HASH_FIELDS) <= _keys(types.Signal)


# --------------------------------------------------------------------------- #
# Node / GraphEdge / Graph <-> what the frontend actually writes
# --------------------------------------------------------------------------- #
# The fixture is PRE-migration data: `make export-playground` writes what the UI held, and
# `normalizeGraph` migrates it on load. So it legitimately carries keys the post-migration
# shapes do not have, and `version` may be absent on a graph old enough to predate it.
#
# Asserting "no extra keys" against it would therefore be wrong, and asserting nothing
# would be useless. Assert the DIFFERENCE instead — it is exactly the set `normalizeGraph`
# is documented to strip, so this pins the migration surface: a new undeclared key means
# either this file is stale or a field was added with no migration to remove it.
_LEGACY_NODE_KEYS = {"cx", "cy"}  # v20 detailed view; normalize.ts:427 folds them into x/y
# v16 view state; normalize.ts:559-560 deletes them. `expanded`/`minimized` are on the same
# list and simply do not appear in today's fixture.
_LEGACY_GRAPH_KEYS = {"viewMode", "viewOverrides"}


def test_fixture_graphs_carry_no_keys_outside_the_declared_shape():
    graphs = _fixture_graphs()
    assert graphs, "no graphs found in playground_pipelines.json"
    declared = _keys(types.Graph)
    extra: set[str] = set()
    for g in graphs:
        extra |= set(g) - declared
        # `version` is NOT required here: one fixture graph predates it, and
        # `normalizeGraph` supplies the default on load.
        assert {"nodes", "edges"} <= set(g)
    assert extra <= _LEGACY_GRAPH_KEYS, (
        f"the fixture's non-declared graph keys are {sorted(extra)}, which is outside the "
        f"legacy set {sorted(_LEGACY_GRAPH_KEYS)} that normalizeGraph strips"
    )


def test_every_fixture_node_is_a_declared_node_plus_only_stripped_legacy_keys():
    declared = _keys(types.Node)
    required = declared - {"name"}
    seen = 0
    extra: set[str] = set()
    for g in _fixture_graphs():
        for n in g["nodes"]:
            seen += 1
            extra |= set(n) - declared
            assert required <= set(n), f"{n.get('type')} missing: {required - set(n)}"
    assert seen, "no nodes in the fixture"
    assert extra <= _LEGACY_NODE_KEYS, (
        f"the fixture's non-declared node keys are {sorted(extra)}, expected exactly the "
        f"legacy set {sorted(_LEGACY_NODE_KEYS)} — either types.Node is stale, or a field "
        f"was added without a normalizeGraph migration to strip it"
    )


def test_fixture_edges_carry_exactly_the_declared_edge_keys():
    declared = _keys(types.GraphEdge)
    seen = 0
    for g in _fixture_graphs():
        for e in g["edges"]:
            seen += 1
            assert set(e) == declared, f"edge shape drifted: {set(e) ^ declared}"
    assert seen, "no edges in the fixture — the parity check would pass vacuously"


def test_a_loose_edge_is_still_a_declared_edge():
    """The parked-wire sentinel is a normal edge with `targetPort == "__in"`, NOT a
    different shape. `types.GraphEdge`'s docstring says so; this pins it, because a
    separate shape is the obvious wrong guess and every hash/validate on both sides
    filters these out by VALUE."""
    loose = {
        "id": "e1",
        "source": "a",
        "sourcePort": "out",
        "target": "b",
        "targetPort": "__in",
    }
    assert set(loose) == _keys(types.GraphEdge)


# --------------------------------------------------------------------------- #
# Export <-> the settings the render actually reads
# --------------------------------------------------------------------------- #
def test_export_declares_every_field_the_hd_path_reads():
    """`song_render.output_from_export` is the lockstep anchor between the two HD paths.
    Anything it reads off an export dict has to be a field this type knows about."""
    from backend import song_render

    src = (paths.PROJECT_ROOT / "backend" / "song_render.py").read_text()
    body = src[src.index("def output_from_export") :]
    body = body[: body.index("\ndef ", 1)]
    read = {k for k in _keys(types.Export) if f'"{k}"' in body}
    assert read, "output_from_export reads no declared export field — did it move?"
    assert hasattr(song_render, "output_from_export")
