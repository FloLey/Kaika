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


def referenced_composition_ids(graph: dict | None) -> set:
    """Composition ids a graph references DIRECTLY — today that is exactly the
    montage card's extracts (`data.extracts[].compositionId`). The extracts wave
    lands the field in step 03; reading it here (empty until then) keeps hashing
    and validation forward-compatible without a second pass later."""
    ids: set = set()
    for n in (graph or {}).get("nodes") or []:
        if n.get("type") != "montage":
            continue
        for ex in (n.get("data") or {}).get("extracts") or []:
            cid = (ex or {}).get("compositionId") if isinstance(ex, dict) else None
            if cid:
                ids.add(cid)
    return ids


def composition_closure(pool: dict | None, seed_ids: set) -> list:
    """The transitive closure of composition references, as an ORDERED list of
    `(comp_id, comp_or_None)` pairs (sorted by id — hashing needs a stable order).
    A dangling reference stays in the list as `(id, None)`: a reference appearing
    or breaking must still move a content hash. Cycle-safe (the pool validator
    refuses cycles, but hashing must not hang on a bad save)."""
    pool = pool or {}
    seen: set = set()
    stack = sorted(seed_ids)
    while stack:
        cid = stack.pop()
        if cid in seen:
            continue
        seen.add(cid)
        comp = pool.get(cid)
        if comp:
            stack.extend(referenced_composition_ids(comp.get("graph")))
    return [(cid, pool.get(cid)) for cid in sorted(seen)]


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
