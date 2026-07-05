"""Runtime registry for generated "card builder" cards (value modulators).

Built-in cards are shipped in git (frontend registry + backend handlers). These
are *user data*: one JSONB definition per card in the `generated_cards` table,
loaded live so a freshly generated card is usable without a restart. This module
is the backend half — it validates a card definition, and compiles + caches its
sandboxed `curve()` so the value resolver can run it.

The definition shape (mirrored on the frontend as a spec):

    {
      "type": "wobble",                # kebab, unique, not a built-in
      "label": "Wobble",
      "category": "modulators",
      "archetype": "value-modulator",
      "help": "one-line palette help",
      "controls": [ {key,label,widget,min,max,step,default,options,help}, … ],
      "inputs": ["in"],                # optional value-input port ids
      "curve_src": "def curve(data, nframes, fps, inputs): …"
    }
"""

from __future__ import annotations

import logging
import re

from . import card_sandbox

log = logging.getLogger("kaika")

# Node types that a generated card may NOT claim — the built-in registry owns them.
# Keep in sync with the frontend registry / card_demo.CARD_LABELS (+ the value
# modulators that aren't Playground cards, e.g. `gate`). A collision here would
# shadow a real card in the resolver, so we reject it at generation time.
RESERVED_TYPES = frozenset({
    "signal", "lfo", "noise", "math", "shaper", "scope", "gate",
    "points", "pattern", "animate-points", "merge-points",
    "fluid", "lyrics", "image", "video", "color", "backdrop",
    "combine", "output",
})

_TYPE_RE = re.compile(r"^[a-z][a-z0-9-]*$")
_WIDGETS = frozenset({"slider", "select", "toggle"})
ARCHETYPE = "value-modulator"

# Compiled-curve cache: type -> (curve_src, callable). Keyed on the source so an
# edited card recompiles; a re-save with identical source reuses the callable.
_compiled: dict[str, tuple[str, object]] = {}


class CardError(Exception):
    """A card definition is malformed (bad shape or unsafe/invalid curve)."""


def _require(cond: bool, msg: str) -> None:
    if not cond:
        raise CardError(msg)


def _clean_control(raw: dict) -> dict:
    """Validate + normalize one control spec, dropping anything unexpected."""
    _require(isinstance(raw, dict), "each control must be an object")
    key = raw.get("key")
    _require(isinstance(key, str) and bool(key), "each control needs a string 'key'")
    widget = raw.get("widget", "slider")
    _require(widget in _WIDGETS, f"control '{key}': widget must be one of {sorted(_WIDGETS)}")
    ctl = {
        "key": key,
        "label": str(raw.get("label", key)),
        "widget": widget,
        "help": str(raw.get("help", "")),
    }
    if widget == "select":
        opts = raw.get("options") or []
        _require(
            isinstance(opts, list) and len(opts) >= 1,
            f"control '{key}': a select needs a non-empty 'options' list",
        )
        ctl["options"] = [str(o) for o in opts]
        ctl["default"] = str(raw.get("default", ctl["options"][0]))
    elif widget == "toggle":
        ctl["default"] = bool(raw.get("default", False))
    else:  # slider
        ctl["min"] = float(raw.get("min", 0.0))
        ctl["max"] = float(raw.get("max", 1.0))
        ctl["step"] = float(raw.get("step", 0.01))
        ctl["default"] = float(raw.get("default", ctl["min"]))
        _require(ctl["max"] > ctl["min"], f"control '{key}': max must exceed min")
    return ctl


def validate_definition(card: dict) -> dict:
    """Validate a raw card definition and return a normalized copy (safe to persist).
    Compiles + smoke-tests the curve as part of validation. Raises CardError."""
    _require(isinstance(card, dict), "card must be an object")

    ctype = card.get("type")
    _require(isinstance(ctype, str) and bool(_TYPE_RE.match(ctype or "")),
             "type must be kebab-case (^[a-z][a-z0-9-]*$)")
    _require(ctype not in RESERVED_TYPES, f"type '{ctype}' collides with a built-in card")

    label = str(card.get("label") or ctype).strip()
    _require(bool(label), "label must not be empty")

    controls = [_clean_control(c) for c in (card.get("controls") or [])]
    keys = [c["key"] for c in controls]
    _require(len(keys) == len(set(keys)), "control keys must be unique")

    inputs = card.get("inputs") or []
    _require(isinstance(inputs, list), "inputs must be a list of port ids")
    inputs = [str(p) for p in inputs]

    curve_src = card.get("curve_src")
    _require(isinstance(curve_src, str) and bool(curve_src.strip()),
             "curve_src must be non-empty Python source")
    # The real safety gate: compile in the sandbox and smoke-test on synthetic data.
    try:
        card_sandbox.build_curve(curve_src, n_inputs=len(inputs), controls=controls)
    except card_sandbox.SandboxError as e:
        raise CardError(str(e)) from e

    return {
        "type": ctype,
        "label": label,
        "category": "modulators",
        "archetype": ARCHETYPE,
        "help": str(card.get("help", "")),
        "controls": controls,
        "inputs": inputs,
        "curve_src": curve_src,
    }


def specs_by_type() -> dict[str, dict]:
    """Every generated card definition, keyed by type. Degrades to {} if the DB is
    unavailable so a render never hard-fails on a missing card store."""
    from . import db  # local import: keeps card_sandbox importable without psycopg

    try:
        return {c["type"]: c for c in db.list_cards() if isinstance(c, dict) and c.get("type")}
    except db.DBUnavailable:
        return {}
    except Exception:  # noqa: BLE001 - a broken store must not break rendering
        log.warning("generated-card store unreadable; ignoring generated cards", exc_info=True)
        return {}


def curve_for(spec: dict):
    """Return the compiled, sandboxed `curve` callable for a card spec, compiling
    (and caching) on first use or after its source changes. Returns None if the
    spec's curve is invalid — the resolver then degrades that node to flat 0."""
    ctype = spec.get("type")
    src = spec.get("curve_src", "")
    cached = _compiled.get(ctype)
    if cached is not None and cached[0] == src:
        return cached[1]
    try:
        fn = card_sandbox.compile_curve(src)
    except card_sandbox.SandboxError:
        log.warning("generated card '%s' has an invalid curve; degrading to flat 0", ctype)
        return None
    _compiled[ctype] = (src, fn)
    return fn
