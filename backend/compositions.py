"""The composition pool — shared resolution helpers.

A *composition* is a graph ending in an `output` card, stored in the project-level
pool ``data.compositions`` (a dict keyed by composition id) and referenced by id:
each segment points at its root composition via ``rootCompositionId``, and (from the
extracts wave onward) a montage extract points at a child composition the same way.
See ``specs/compositions/README.md`` for the model.

This module holds only the pure lookups every consumer (export, cache GC, routes)
needs; rendering-side recursion lives with the montage handler in ``graph_render``.
"""

from __future__ import annotations


def root_composition(pool: dict | None, seg: dict) -> dict | None:
    """The segment's root composition record, or None when the segment has no
    animation yet (no reference, or a dangling one)."""
    return (pool or {}).get(seg.get("rootCompositionId") or "")


def final_output_id(comp: dict | None) -> str | None:
    """The output node a composition's product renders from: its explicit
    ``outputId`` when set, else the SOLE output card in its graph — with several
    outputs and no mark it is genuinely ambiguous, so None."""
    if not comp:
        return None
    oid = comp.get("outputId")
    nodes = (comp.get("graph") or {}).get("nodes") or []
    outs = [n.get("id") for n in nodes if n.get("type") == "output"]
    if oid in outs:
        return oid
    return outs[0] if len(outs) == 1 else None
