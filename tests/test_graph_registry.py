"""The backend node-handler registry stays consistent.

History of this file, because it explains what is deliberately NOT here:

* It used to assert `set(_VIDEO_PRODUCERS) == set(_VIDEO_HANDLERS)` — which
  `graph_render` already asserts at IMPORT time, so a violation raised during
  collection and the test body was unreachable. And two lines asserting
  `dict.get("totally-new") is None`, which tests Python.
* Cleanup step 03 replaced those with regex readers that compared the backend tables
  against the frontend's hand-written copies.
* Cleanup step 08 made those copies GENERATED (`frontend/src/lib/graph/generated.ts`
  via `backend.gen_fluid_params`), so the comparison is now a no-diff codegen check
  living in `test_fluid_params_codegen.py` — the same guard shape as fluidParams.js.
  Parsing TypeScript with regexes to check a mirror is no longer necessary: there is
  no mirror.

What is left is the one thing neither the import-time assert nor codegen covers.
"""

from __future__ import annotations

from backend import graph


def test_core_node_types_are_registered():
    """The three types every graph needs dispatch on both paths."""
    for t in ("fluid", "combine", "output"):
        assert t in graph._VIDEO_HANDLERS
        assert t in graph._EMITTER_HANDLERS
        assert callable(graph._VIDEO_HANDLERS[t])
        assert callable(graph._EMITTER_HANDLERS[t])


def test_every_video_handler_has_a_block_handler():
    """Whole-clip and block dispatch must cover the same cards.

    `_whole_from_block(card)` looks the card up in `_BLOCK_HANDLERS` at CALL time, so a
    card registered as derived but missing its block handler raises KeyError mid-render
    — during an export, not at import. After step 07 all but five cards derive this way,
    which makes this the cheap guard that the import-time producer assert doesn't give.
    """
    missing = sorted(set(graph._VIDEO_HANDLERS) - set(graph._BLOCK_HANDLERS))
    assert missing == [], f"cards with no block handler: {missing}"
