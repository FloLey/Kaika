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

# Plain-language help per field, shown as hover tooltips in the inspector and
# embedded in the chat copilot's schema context. Wildcards as in UI.
HELP: dict = {
    "seed": "Same seed = identical video. Change it to reshuffle randomness.",
    "canvas.width": "Output video width in pixels.",
    "canvas.height": "Output video height in pixels.",
    "canvas.fps": "Video framerate; analysis is locked to it frame-for-frame.",
    "canvas.sim_resolution": "Simulation cells on the SHORT side. Higher = "
        "finer fluid detail but slower previews.",
    "field.dissipation": "How much dye survives each frame. Lower = trails "
        "clear faster; higher = colour lingers.",
    "field.velocity_dissipation": "How much motion survives each frame. "
        "Lower = the fluid calms down faster.",
    "field.viscosity": "Thickness of the fluid; smooths and slows the motion.",
    "field.vorticity": "Swirl reinforcement. Higher = curlier, more turbulent "
        "(by default RMS drives this via a modulator).",
    "field.vorticity_gain": "Internal scale of the swirl force — small "
        "changes have big effects (advanced).",
    "field.force_gain": "How strongly emitter impulses push the fluid "
        "(advanced).",
    "field.density_clamp": "Ceiling on accumulated dye brightness (HDR).",
    "field.ambient.strength": "Continuous background stirring so the fluid "
        "is always alive (by default RMS drives this).",
    "field.ambient.scale": "Spatial size of the ambient swirls — higher = "
        "smaller, busier swirls.",
    "field.ambient.speed": "How fast the ambient stirring pattern evolves.",
    "render.exposure": "Overall brightness of the tone-mapped image.",
    "render.bloom.amount": "Glow added around bright areas.",
    "render.bloom.threshold": "Brightness above which bloom kicks in.",
    "render.bloom.sigma": "Blur radius of the glow. 0 = automatic.",
    "render.background": "Dark floor level — lifts pure black.",
    "render.gamma": "Contrast curve of the final image.",
    "diffusion.strength": "How strongly the diffusion model restyles the "
        "fluid: low = faithful to the motion, high = freer reinterpretation.",
    "post.grain": "Film grain on the final clip (fuses diffusion artefacts).",
    "post.vignette": "Darkened corners on the final clip.",
    # emitters
    "emitters.*.count": "Sources spawned per trigger event (e.g. 3 = three "
        "simultaneous jets).",
    "emitters.*.enabled": "Untick to silence this emitter entirely.",
    "emitters.*.trigger.type": "What fires it: onset = a detected hit, beat "
        "= the metronome grid, continuous = steady cadence, lookahead = "
        "ramps up before a section, manual = only from the timeline.",
    "emitters.*.trigger.band": "Which band's onsets: low = kicks, mid = "
        "melody, high = hats.",
    "emitters.*.trigger.min_mag": "Ignore hits weaker than this (0–1).",
    "emitters.*.trigger.max_per_frame": "Cap of hits per frame (0 = no cap).",
    "emitters.*.trigger.every": "Beat divider: 1 = every beat, 4 = once a bar.",
    "emitters.*.trigger.offset": "Shifts which beat counts as the first.",
    "emitters.*.trigger.every_frames": "Cadence in frames for continuous / "
        "lookahead triggers.",
    "emitters.*.trigger.when": "Condition for continuous triggers, e.g. "
        "\"rms > 0.5\".",
    "emitters.*.trigger.mag_source": "Continuous triggers: spawn strength "
        "follows this signal (e.g. 'voice' = sustained vocal presence); "
        "min_mag gates weak frames out.",
    "emitters.*.trigger.section": "Section label this trigger targets "
        "(lookahead) or filters on (continuous).",
    "emitters.*.trigger.window_s": "Seconds before the section start during "
        "which the lookahead ramps up.",
    "emitters.*.placement.type": "Where sources appear: fixed points, random "
        "region, wandering anchor, line, circle, grid, or position driven by "
        "an audio signal.",
    "emitters.*.placement.jitter": "Random spread around the computed spot.",
    "emitters.*.placement.wander_amp": "How far the anchor orbits its center.",
    "emitters.*.placement.wander_freq": "How fast the anchor orbits.",
    "emitters.*.placement.radius": "Circle radius (fraction of the canvas).",
    "emitters.*.placement.arc_deg": "Arc of the circle (360 = full ring).",
    "emitters.*.placement.rows": "Grid rows.",
    "emitters.*.placement.cols": "Grid columns.",
    "emitters.*.placement.source": "Audio signal that drives the position "
        "(e.g. chroma_argmax = pitch).",
    "emitters.*.placement.range": "Position range the signal maps into (0–1).",
    "emitters.*.placement.x": "Fixed horizontal position for signal_y.",
    "emitters.*.placement.y": "Fixed vertical position for signal_x.",
    "emitters.*.placement.points": "Explicit positions (0–1); a line uses "
        "the first two as its endpoints.",
    "emitters.*.placement.region": "Rectangle [x0, y0, x1, y1] for random "
        "placement.",
    "emitters.*.placement.center": "Reference center (0–1 per axis).",
    "emitters.*.direction.type": "Initial heading of the jet: radial_out = "
        "away from the center, flow = follow the current, fixed = angle_deg.",
    "emitters.*.direction.angle_deg": "Fixed heading in degrees (0 = right, "
        "90 = down).",
    "emitters.*.direction.jitter": "Randomness on the heading (radians).",
    "emitters.*.color.type": "How the colour is picked: palette index, "
        "cycling, random, pitch → hue wheel, pitch → palette, brightness "
        "ramp by spectral centroid, or a fixed hex.",
    "emitters.*.color.hex": "Fixed colour (used when type = fixed).",
    "emitters.*.color.palette": "Which named palette to draw from.",
    "emitters.*.color.index": "Palette entry (type = palette).",
    "emitters.*.color.start": "First palette index the cycle uses.",
    "emitters.*.color.hue_offset": "Rotates the pitch → hue wheel (degrees).",
    "emitters.*.color.saturation": "HSV saturation for chroma_hue.",
    "emitters.*.color.value": "HSV brightness for chroma_hue.",
    "emitters.*.color.dark": "Colour at a dark/low spectral centroid.",
    "emitters.*.color.bright": "Colour at a bright/high spectral centroid.",
    "emitters.*.color.min_hold_s": "How long a new pitch must persist before "
        "the colour switches (anti-flicker).",
    "emitters.*.color.opacity": "Multiplies the colour's intensity.",
    "emitters.*.color.brightness.source": "What drives brightness: fixed "
        "value, spectral centroid, or loudness.",
    "emitters.*.color.brightness.value": "Brightness multiplier (fixed).",
    "emitters.*.color.brightness.range": "Brightness range the signal maps "
        "into.",
    "emitters.*.body.radius": "Size of the source (fraction of the short "
        "side).",
    "emitters.*.body.force": "Initial impulse strength — how hard it kicks "
        "the fluid.",
    "emitters.*.body.lifetime_s": "How long the source lives and emits.",
    "emitters.*.body.emit": "Dye amount it releases while alive.",
    "emitters.*.body.drift": "How strongly the flow carries the source.",
    "emitters.*.body.speed": "Self-propulsion along its heading.",
    "emitters.*.body.jet_fraction": "Ongoing push along the heading, as a "
        "fraction of the initial impulse.",
    "emitters.*.body.decay": "Emission envelope: higher = more front-loaded, "
        "punchier.",
    "emitters.*.body.expand": "How much its radius grows over its lifetime.",
    "emitters.*.body.mag_gain": "How much the hit's strength scales this "
        "spawn (0 = ignore magnitude).",
    # modulators
    "modulators.*.source": "The audio signal that drives the target.",
    "modulators.*.target": "Dot-path of the parameter being driven "
        "(field.* / render.* / emitters.<id>.*).",
    "modulators.*.range": "Signal 0 maps to the first value, signal 1 to the "
        "second.",
    "modulators.*.mode": "absolute = the signal owns the target; add / scale "
        "= move around the segment's base value.",
    "modulators.*.curve": "Shaping: linear, pow(k), smoothstep, step(t).",
    "modulators.*.smooth_s": "Low-pass on the signal (seconds) — smooths "
        "jittery response.",
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
    "emitters.*.trigger.mag_source": [""] + list(R.SIGNALS),
    "emitters.*.placement.source": list(R.SIGNALS),
    "modulators.*.apply_to": ["spawn"],          # "live" reserved, rejected
    "diffusion.backend": ["local", "comfyui"],
}


def _wild_lookup(table: dict, path: str):
    """Look up an annotation, treating list indices / emitter ids as '*'."""
    if path in table:
        return table[path]
    parts = path.split(".")
    for i in range(1, len(parts)):
        wp = ".".join(parts[:i] + ["*"] + parts[i + 1:])
        if wp in table:
            return table[wp]
    return None


def _ui_for(path: str) -> dict:
    ui = dict(_wild_lookup(UI, path) or {})
    help_ = _wild_lookup(HELP, path)
    if help_:
        ui["help"] = help_
    return ui


def _enum_for(path: str):
    return _wild_lookup(ENUMS, path)


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
