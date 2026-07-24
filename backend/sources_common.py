"""The handful of things every source-card module needs.

Split out of `sources.py` (cleanup step 27). `_at` is here rather than in one of the
three card modules because both `sources_text` and `sources_gen` sample per-frame
parameter arrays with it, and neither should have to import the other to do so.
"""

from __future__ import annotations

from .animation_params import SOURCE_PARAM_SPEC

# key -> (min, max, default) per source card — the executor's compact view, derived
# from the rich spec in animation_params (which also generates the frontend table,
# so the UI [lo, hi] can never drift from what the render maps).
SOURCE_PARAMS: dict[str, dict[str, tuple[float, float, float]]] = {
    card: {p["key"]: (p["min"], p["max"], p["default"]) for p in spec}
    for card, spec in SOURCE_PARAM_SPEC.items()
}


def _at(v, i):
    """Index a per-frame array, or pass a scalar through (outline colour defaults)."""
    return v[i] if hasattr(v, "__len__") else v
