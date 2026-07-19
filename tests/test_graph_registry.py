"""The backend node-handler registry stays consistent, and the frontend agrees with it.

Two different jobs:

* `test_core_node_types_are_registered` — the dispatch tables are populated.
* `test_*_matches_the_frontend` — the three constants that are **hand-copied across the
  language barrier** still agree. Nothing else checks these, and drift is silent: the
  digests differ by design, so a mismatch produces a wrong render or a card the frontend
  refuses to draw, never a red test.

The producer-set-vs-handler-table check that used to live here was deleted: it asserted
what `graph_render` already asserts at IMPORT time, so a violation raised during
collection and the test body was unreachable. Two lines below it asserted that
`dict.get("totally-new") is None`, which tests Python.

These regex readers are an interim guard. Cleanup step 08 replaces them by generating the
frontend constants from the backend, at which point the parity is structural and these
tests become a no-diff codegen check like `test_fluid_params_codegen.py`.
"""

from __future__ import annotations

import re
from pathlib import Path

from backend import graph
from backend.graph_common import VIDEO_PRODUCERS
from backend.graph_hash import _SIGNAL_HASH_FIELDS, _SLOT_CARDS

_LIB = Path(__file__).resolve().parents[1] / "frontend" / "src" / "lib" / "graph"

# `//` comments inside the literals carry real explanation (e.g. why montage is not
# VIDEO_FX), so strip them before pulling strings out — otherwise a quoted word in a
# comment would read as a member.
_LINE_COMMENT = re.compile(r"//[^\n]*")


def _ts_literal(source: str, name: str) -> str:
    """The bracketed body of `const <name> = ...[ ... ]`, comments stripped.

    Brace-matched rather than regex-terminated: the literals span many lines and
    `VIDEO_PRODUCERS` nests a spread, so a lazy `.*?\\]` would stop at the wrong bracket.
    """
    start = source.index(f"const {name}")
    open_at = source.index("[", start)
    depth = 0
    for i in range(open_at, len(source)):
        if source[i] == "[":
            depth += 1
        elif source[i] == "]":
            depth -= 1
            if depth == 0:
                return _LINE_COMMENT.sub("", source[open_at : i + 1])
    raise AssertionError(f"unterminated literal for {name}")


def _members(source: str, name: str) -> set[str]:
    """Quoted members of a TS array/Set literal, resolving `...OTHER` spreads."""
    body = _ts_literal(source, name)
    out = set(re.findall(r'"([^"]+)"', body))
    for spread in re.findall(r"\.\.\.([A-Za-z_][A-Za-z0-9_]*)", body):
        out |= _members(source, spread)
    return out


def test_core_node_types_are_registered():
    for t in ("fluid", "combine", "output"):
        assert t in graph._VIDEO_HANDLERS
        assert t in graph._EMITTER_HANDLERS
        assert callable(graph._VIDEO_HANDLERS[t])
        assert callable(graph._EMITTER_HANDLERS[t])


def test_video_producers_match_the_frontend():
    """`graph_common.VIDEO_PRODUCERS` vs `lib/graph/core.ts`.

    A card added to one side only: the backend renders it and the frontend refuses to
    (or the reverse). Visible immediately in the UI, but nothing fails in CI.
    """
    ts = _members((_LIB / "core.ts").read_text(), "VIDEO_PRODUCERS")
    assert ts == set(VIDEO_PRODUCERS), (
        "VIDEO_PRODUCERS drifted between backend/graph_common.py and "
        f"frontend/src/lib/graph/core.ts.\n  backend only: {sorted(set(VIDEO_PRODUCERS) - ts)}"
        f"\n  frontend only: {sorted(ts - set(VIDEO_PRODUCERS))}"
    )


def test_signal_hash_fields_match_the_frontend():
    """`graph_hash._SIGNAL_HASH_FIELDS` vs `lib/graph/hash.ts`.

    The nastier of the two: the sides compute cache keys over different field sets, so
    the preview and the export silently disagree about what a graph *is*. It surfaces as
    "the export doesn't match what I previewed" and reads like a render bug.
    """
    ts = _members((_LIB / "hash.ts").read_text(), "SIGNAL_HASH_FIELDS")
    assert ts == set(_SIGNAL_HASH_FIELDS), (
        "SIGNAL_HASH_FIELDS drifted — cache keys will disagree across the barrier.\n"
        f"  backend only: {sorted(set(_SIGNAL_HASH_FIELDS) - ts)}\n"
        f"  frontend only: {sorted(ts - set(_SIGNAL_HASH_FIELDS))}"
    )


def test_slot_cards_match_the_frontend():
    """`graph_hash._SLOT_CARDS` vs `lib/graph/hash.ts` (which says "mirrors backend" in a
    comment — this is that comment, enforced)."""
    ts = _members((_LIB / "hash.ts").read_text(), "SLOT_CARDS")
    assert ts == set(_SLOT_CARDS), (
        f"SLOT_CARDS drifted.\n  backend only: {sorted(set(_SLOT_CARDS) - ts)}\n"
        f"  frontend only: {sorted(ts - set(_SLOT_CARDS))}"
    )
