"""The five domain objects, as shapes.

Every one of these travels the whole system as a bare `dict`: parsed from a request body,
walked by the graph executor, hashed into a cache key, written back to Postgres as JSONB.
That works, and none of the annotations here change a line of behaviour — Python does not
enforce a `TypedDict` at runtime, and this repo runs no static type checker.

So what are they for? Two things a docstring cannot do:

1. **An editor can answer "what is on a node?"** `graph.py` and its five modules take
   `node: dict` in ~130 signatures. The shape lives in `frontend/src/lib/types.ts`, on the
   other side of the wire, in a language the backend does not read.
2. **`test_domain_types.py` ties the field names to the tables that already enforce
   them.** `_SIGNAL_HASH_FIELDS` is positional and hashed; `VIDEO_PRODUCERS` is codegen'd
   to the frontend. A `Signal` here that disagrees with the hash tuple is a bug in one of
   the two, and the test says which.

⚠ **These are descriptions, not gates.** Nothing fails when reality drifts, except the
parity test below and only for the fields it covers. Do not read an annotation here as a
guarantee that a key is present — the executor's `.get(k, default)` calls are still the
contract, and several of these dicts arrive straight from a request body.

The authority for each shape is `frontend/src/lib/types.ts` (and `lib/export.ts`), because
the frontend is what constructs them. Where the two disagree, the frontend is right and
this file is stale.
"""

from __future__ import annotations

from typing import Any, Literal, NotRequired, TypedDict

# --------------------------------------------------------------------------- #
# Signals — a frequency band, and how its measurement is shaped.
# --------------------------------------------------------------------------- #


class Signal(TypedDict):
    """One extracted control curve.

    Every field except `id`/`name` is in `graph_hash._SIGNAL_HASH_FIELDS`, which is the
    real definition of "affects the picture" — and the reason a signal edit invalidates a
    render while a rename does not.
    """

    id: str
    stemKey: str
    minHz: float
    maxHz: float
    feature: str
    attack: float
    release: float
    invert: bool
    gamma: float
    gain: float
    offset: float
    threshold: float
    name: NotRequired[str]


# --------------------------------------------------------------------------- #
# The graph — cards and the wires between them.
# --------------------------------------------------------------------------- #


class Node(TypedDict):
    """One card.

    `data` stays `dict[str, Any]` deliberately. It is 35 different shapes selected by
    `type`, the executor reaches into it with `.get(key, default)` throughout, and the
    per-card param bounds are already enforced somewhere better: `animation_params.py`'s
    spec tables, which codegen to the frontend and are asserted by
    `test_fluid_params_codegen.py`. A union of 35 members here would duplicate that
    without enforcing it.
    """

    id: str
    type: str
    x: float
    y: float
    data: dict[str, Any]
    # NODE-level on purpose: `output_hash` serializes only {id, type, data}, so renaming a
    # card never busts the render cache.
    name: NotRequired[str]


class GraphEdge(TypedDict):
    """One wire.

    ⚠ `targetPort` may be the LOOSE sentinel `"__in"` — a parked wire with no binding.
    Every hash and every validate on both sides must filter those out; see
    `graph_hash._wired_ports`.
    """

    id: str
    source: str
    sourcePort: str
    target: str
    targetPort: str


class Graph(TypedDict):
    """One composition's node graph. `version` is the frontend's `GRAPH_VERSION`."""

    version: int
    nodes: list[Node]
    edges: list[GraphEdge]
    view: NotRequired[dict[str, float]]


# --------------------------------------------------------------------------- #
# Segments — the song, cut up.
# --------------------------------------------------------------------------- #


class Segment(TypedDict):
    """A labelled span of the song, its signals, and the composition it renders with.

    `rootCompositionId` points into the project's composition POOL rather than holding a
    graph: since the compositions wave, a graph is shared by reference and one segment
    does not own it.
    """

    id: str
    label: str
    start: float
    end: float
    signals: list[Signal]
    rootCompositionId: NotRequired[str]


# --------------------------------------------------------------------------- #
# Render settings.
# --------------------------------------------------------------------------- #


class Output(TypedDict):
    """The studio canvas: what a preview renders at."""

    width: int
    height: int
    fps: int
    quality: Literal["draft", "normal", "high"]
    background: NotRequired[str]


class Export(TypedDict):
    """The final whole-song render. Separate from `Output` because it is deliberately
    allowed to differ — the canvas is a working size, this is the delivered one.

    Both HD paths send `nativeShort` derived from these (`song_render.output_from_export`
    is the lockstep anchor), so both resolve a segment to the same size.
    """

    width: int
    height: int
    fps: int
    gridCells: int
    audioMode: Literal["original", "instrumental"]
    imageSize: int
