"""Recipe JSON Schema, generated from the dataclasses, with ``ui`` annotations.

One document feeds everything: server-side validation hints, the schema-driven
inspector (tier / widget / group / min / max / step), YAML diagnostics, and the
chat copilot's system prompt. Curation is data — moving a field between the
card face and the advanced view is one annotation here, not UI code.
"""
from __future__ import annotations

from dataclasses import fields, is_dataclass, MISSING
from typing import get_type_hints, get_origin, get_args

from . import recipe as R

# ---------------------------------------------------------------------------
# UI annotations: dot-path -> {tier, widget, group, label, min, max, step}.
# Anything not listed defaults to tier "advanced" with a generic widget.
# ---------------------------------------------------------------------------
UI: dict = {
    # canvas
    "canvas.width":   {"tier": "primary", "min": 64, "max": 4096, "step": 2},
    "canvas.height":  {"tier": "primary", "min": 64, "max": 4096, "step": 2},
    "canvas.fps":     {"tier": "primary", "min": 12, "max": 60, "step": 1},
    "canvas.sim_resolution": {"tier": "primary", "min": 64, "max": 768, "step": 16},
    # field
    "field.vorticity": {"tier": "primary", "min": 0, "max": 90, "step": 1,
                        "label": "Vorticity"},
    "field.dissipation": {"tier": "primary", "min": 0.8, "max": 0.995,
                          "step": 0.005, "label": "Dye fade"},
    "field.velocity_dissipation": {"tier": "advanced", "min": 0.85, "max": 1.0,
                                   "step": 0.005},
    "field.viscosity": {"tier": "advanced", "min": 0.0, "max": 2.0, "step": 0.05},
    "field.vorticity_gain": {"tier": "advanced", "min": 0.0, "max": 0.05,
                             "step": 0.001},
    "field.force_gain": {"tier": "advanced", "min": 0.0, "max": 0.2,
                         "step": 0.005},
    "field.density_clamp": {"tier": "advanced", "min": 1.0, "max": 30.0,
                            "step": 0.5},
    "field.ambient.strength": {"tier": "primary", "min": 0.0, "max": 6.0,
                               "step": 0.1, "label": "Ambient stir"},
    "field.ambient.scale": {"tier": "advanced", "min": 0.5, "max": 8.0,
                            "step": 0.1},
    "field.ambient.speed": {"tier": "advanced", "min": 0.0, "max": 1.0,
                            "step": 0.01},
    # render
    "render.exposure": {"tier": "primary", "min": 0.5, "max": 4.0, "step": 0.1},
    "render.bloom.amount": {"tier": "primary", "min": 0.0, "max": 2.0,
                            "step": 0.05, "label": "Bloom"},
    "render.bloom.threshold": {"tier": "advanced", "min": 0.0, "max": 1.0,
                               "step": 0.05},
    "render.bloom.sigma": {"tier": "advanced", "min": 0.0, "max": 32.0,
                           "step": 0.5},
    "render.background": {"tier": "advanced", "min": 0.0, "max": 0.3,
                          "step": 0.01},
    "render.gamma": {"tier": "advanced", "min": 0.8, "max": 2.0, "step": 0.05},
    # emitter body
    "emitters.*.count": {"tier": "primary", "min": 1, "max": 16, "step": 1},
    "emitters.*.body.radius": {"tier": "primary", "min": 0.01, "max": 0.4,
                               "step": 0.005},
    "emitters.*.body.force": {"tier": "primary", "min": 0, "max": 20000,
                              "step": 100},
    "emitters.*.body.lifetime_s": {"tier": "primary", "min": 0.1, "max": 4.0,
                                   "step": 0.05},
    "emitters.*.body.emit": {"tier": "primary", "min": 0.0, "max": 1.0,
                             "step": 0.01},
    "emitters.*.body.drift": {"tier": "advanced", "min": 0.0, "max": 2.0,
                              "step": 0.05},
    "emitters.*.body.speed": {"tier": "advanced", "min": 0.0, "max": 6.0,
                              "step": 0.1},
    "emitters.*.body.jet_fraction": {"tier": "advanced", "min": 0.0, "max": 1.0,
                                     "step": 0.05},
    "emitters.*.body.decay": {"tier": "advanced", "min": 0.0, "max": 4.0,
                              "step": 0.1},
    "emitters.*.body.expand": {"tier": "advanced", "min": 0.0, "max": 3.0,
                               "step": 0.1},
    "emitters.*.body.mag_gain": {"tier": "advanced", "min": 0.0, "max": 3.0,
                                 "step": 0.1},
    "emitters.*.trigger.min_mag": {"tier": "advanced", "min": 0.0, "max": 1.0,
                                   "step": 0.05},
    "emitters.*.trigger.max_per_frame": {"tier": "advanced", "min": 0,
                                         "max": 20, "step": 1},
    "emitters.*.trigger.every": {"tier": "advanced", "min": 1, "max": 16,
                                 "step": 1},
    "emitters.*.trigger.window_s": {"tier": "advanced", "min": 0.5, "max": 20.0,
                                    "step": 0.5},
    "emitters.*.placement": {"widget": "pad2d"},
    "emitters.*.color.hex": {"widget": "color"},
    "emitters.*.color.opacity": {"tier": "advanced", "min": 0.0, "max": 1.0,
                                 "step": 0.05},
    "emitters.*.color.min_hold_s": {"tier": "advanced", "min": 0.0, "max": 2.0,
                                    "step": 0.05},
    # modulators
    "modulators.*": {"widget": "curve"},
    "modulators.*.smooth_s": {"tier": "advanced", "min": 0.0, "max": 2.0,
                              "step": 0.05},
    # post
    "post.grain": {"tier": "advanced", "min": 0.0, "max": 1.0, "step": 0.05},
    "post.vignette": {"tier": "advanced", "min": 0.0, "max": 1.0, "step": 0.05},
    "diffusion.strength": {"tier": "primary", "min": 0.1, "max": 0.9,
                           "step": 0.05, "label": "Denoise strength"},
}

# Enum constraints surfaced into the schema.
ENUMS: dict = {
    "emitters.*.trigger.type": list(R.TRIGGER_TYPES),
    "emitters.*.trigger.band": ["low", "mid", "high"],
    "emitters.*.placement.type": list(R.PLACEMENT_TYPES),
    "emitters.*.direction.type": list(R.DIRECTION_TYPES),
    "emitters.*.color.type": list(R.COLOR_TYPES),
    "emitters.*.color.brightness.source": ["fixed", "centroid", "rms"],
    "modulators.*.mode": list(R.MOD_MODES),
    "modulators.*.source": list(R.SIGNALS),
    "modulators.*.apply_to": ["spawn"],          # "live" reserved, rejected
    "diffusion.backend": ["local", "comfyui"],
}


def _ui_for(path: str) -> dict:
    """Look up an annotation, treating list indices / emitter ids as '*'."""
    if path in UI:
        return dict(UI[path])
    parts = path.split(".")
    for i in range(1, len(parts)):
        wp = ".".join(parts[:i] + ["*"] + parts[i + 1:])
        if wp in UI:
            return dict(UI[wp])
    return {}


def _enum_for(path: str):
    if path in ENUMS:
        return ENUMS[path]
    parts = path.split(".")
    for i in range(1, len(parts)):
        wp = ".".join(parts[:i] + ["*"] + parts[i + 1:])
        if wp in ENUMS:
            return ENUMS[wp]
    return None


def _field_schema(ftype, default, path: str) -> dict:
    origin = get_origin(ftype)
    args = get_args(ftype)
    out: dict
    if is_dataclass(ftype):
        out = _dataclass_schema(ftype, path)
    elif origin is list:
        item = (_dataclass_schema(args[0], path + ".*") if args and
                is_dataclass(args[0]) else
                {"type": "number"} if args and args[0] in (int, float) else {})
        out = {"type": "array", "items": item}
    elif origin is dict:
        out = {"type": "object",
               "additionalProperties": (
                   _dataclass_schema(args[1], path + ".*")
                   if len(args) == 2 and is_dataclass(args[1]) else {})}
    elif ftype is bool:
        out = {"type": "boolean"}
    elif ftype is int:
        out = {"type": "integer"}
    elif ftype is float:
        out = {"type": "number"}
    elif ftype is str:
        out = {"type": "string"}
    else:
        out = {}
    if default is not MISSING:
        out["default"] = default
    enum = _enum_for(path)
    if enum:
        out["enum"] = enum
    ui = _ui_for(path)
    if ui:
        out["ui"] = ui
        for k in ("min", "max"):
            if k in ui:
                out["minimum" if k == "min" else "maximum"] = ui[k]
    return out


def _dataclass_schema(cls, path: str = "") -> dict:
    hints = get_type_hints(cls)
    props = {}
    for f in fields(cls):
        name = "field" if f.name == "field_" else f.name
        sub_path = f"{path}.{name}".lstrip(".")
        if f.default is not MISSING:
            default = f.default
        elif f.default_factory is not MISSING:          # type: ignore[misc]
            try:
                d = f.default_factory()                  # type: ignore[misc]
                default = d if isinstance(d, (int, float, str, bool, list,
                                              dict, type(None))) else MISSING
            except Exception:
                default = MISSING
        else:
            default = MISSING
        props[name] = _field_schema(hints.get(f.name, object), default,
                                    sub_path)
    out = {"type": "object", "properties": props}
    ui = _ui_for(path) if path else {}
    if ui:
        out["ui"] = ui
    return out


def recipe_schema() -> dict:
    """The full recipe v2 JSON Schema with ``ui`` annotations."""
    schema = _dataclass_schema(R.Recipe)
    schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    schema["title"] = "Kaika recipe v2"
    # Reserved fields, present so they round-trip but rejected by validation.
    schema["reserved"] = {"modulators.*.apply_to": ["live"],
                          "emitters.*.color.pitch_map": "reserved (post-v2)",
                          "emitters.*.color.key_relative": "reserved (post-v2)"}
    return schema
