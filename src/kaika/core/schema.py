"""Recipe JSON Schema, generated from the dataclasses, with ``ui`` annotations.

One document feeds everything: server-side validation hints, the schema-driven
inspector (tier / widget / group / min / max / step), YAML diagnostics, and the
chat copilot's system prompt. Curation is data — moving a field between the
card face and the advanced view is one annotation here, not UI code.
"""
from __future__ import annotations

import json
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
    "field.detail": {"tier": "advanced", "min": 0.5, "max": 4.0, "step": 0.1},
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
    "render.background": {"tier": "primary", "min": 0.0, "max": 0.3,
                          "step": 0.01, "label": "Background level"},
    "render.background_color.type": {"tier": "primary"},
    "render.background_smooth_s": {"tier": "advanced", "min": 0.0, "max": 8.0,
                                   "step": 0.25},
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
    "emitters.*.placement.turns": {"tier": "advanced", "min": 0.25, "max": 8.0,
                                   "step": 0.25},
    "emitters.*.placement.inner_radius": {"tier": "advanced", "min": 0.0,
                                          "max": 0.5, "step": 0.01},
    "emitters.*.placement.start_deg": {"tier": "advanced", "min": 0.0,
                                       "max": 360.0, "step": 5.0},
    "emitters.*.placement.sequence": {"tier": "advanced", "min": 0, "max": 64,
                                      "step": 1},
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
    "palettes": "Named lists of hex colors, referenced by emitter colors and "
        "the background.",
    "prompts": "Per-section diffusion style prompts; keys are section labels "
        "plus 'base' (always prepended) and 'default'.",
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
    "field.detail": "Swirl fineness. 1.0 = the draft preview's turbulence "
        "scale at any output resolution (the velocity grid stays at the "
        "calibrated size); 2.0 = twice finer, more nervous swirls; below 1 "
        "= chunkier.",
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
    "render.background": "Background tint intensity (0 = pure black). "
        "Modulate it with rms to make the field breathe with the music.",
    "render.background_color.type": "What colors the background: fixed hex, "
        "a palette entry, pitch -> hue wheel (chroma_hue), pitch -> palette "
        "(chroma_palette), brightness ramp by spectral centroid "
        "(centroid_ramp), or palette colors weighted by low/mid/high band "
        "energy (band_mix).",
    "render.background_smooth_s": "How slowly the background color drifts "
        "toward its target (seconds) — keeps the wash gentle, not strobing.",
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
        "region, wandering anchor, line, circle, spiral, grid, or position "
        "driven by an audio signal.",
    "emitters.*.placement.jitter": "Random spread around the computed spot.",
    "emitters.*.placement.wander_amp": "How far the anchor orbits its center.",
    "emitters.*.placement.wander_freq": "How fast the anchor orbits.",
    "emitters.*.placement.radius": "Circle radius / spiral outer radius "
        "(fraction of the canvas).",
    "emitters.*.placement.arc_deg": "Arc of the circle (360 = full ring).",
    "emitters.*.placement.inner_radius": "Radius where the spiral starts "
        "(0 = the exact center).",
    "emitters.*.placement.turns": "Revolutions of the spiral from center to "
        "rim.",
    "emitters.*.placement.start_deg": "Angle of the first point on a circle "
        "or spiral.",
    "emitters.*.placement.sequence": "Successive trigger hits advance along "
        "the shape (line/circle/spiral) instead of spawning the whole shape "
        "at once: hit k sits at position (k mod N)/N. 0 = off. Perfect for "
        "rapid onset runs tracing a path.",
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
    "render.background_color.type": list(R.COLOR_TYPES),
    "render.background_color.brightness.source": ["fixed", "centroid", "rms"],
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


# ---------------------------------------------------------------------------
# Chat copilot reference: the schema rendered as compact text, one line per
# leaf, so the copilot's knowledge regenerates from the same source as the
# inspector — a new engine field/enum value reaches the model automatically.
# ---------------------------------------------------------------------------

# Timeline directives and modulator routing live outside the recipe
# dataclasses, so their grammar is documented here, next to the generator.
TIMELINE_DOC = """timeline directives (project-level; tools add/update/remove_timeline_directive):
  anchors: seconds (3.2) | 'section:drop' | 'section:drop+4.5' | 'beat:32' | 'bar:8'
  spawn (default): {at, emitter?, mag?, count?, placement?, color?, body?} — one-off burst; overrides merge over the emitter's config; no emitter = inline one-shot
  set: {between: [t0, t1], set: {"dot.path": value, ...}, fade_s?} — override numeric recipe values over a time window (eased in/out)
  mute / unmute: {at, emitter} — silence/restore an emitter from that moment; pair them to confine an emitter to a section"""

MODULATOR_DOC = ("modulators (audio signal -> numeric recipe leaf, every frame):\n"
                 "  sources: " + ", ".join(R.SIGNALS) + "\n"
                 "  modes: absolute | add | scale; curves: linear | smoothstep"
                 " | pow(k) | step(t); smooth_s low-passes the signal\n"
                 "  targets: any numeric dot-path under field.*, render.*,"
                 " emitters.<id>.*")


def _leaf_line(path: str, node: dict) -> str:
    enum = node.get("enum")
    typ = ("|".join(str(e) for e in enum) if enum
           else node.get("type", "any"))
    rng = ""
    if "minimum" in node or "maximum" in node:
        rng = f" {node.get('minimum', '')}..{node.get('maximum', '')}"
    dflt = ""
    if node.get("default") not in (None, [], {}, ""):
        dflt = f" (default {json.dumps(node['default'])})"
    help_ = (node.get("ui") or {}).get("help", "")
    if help_:
        first = help_.split(". ")[0].rstrip(".")
        help_ = f" — {first}."
    return f"{path}: {typ}{rng}{dflt}{help_}"


def chat_reference() -> str:
    """The whole recipe schema as one compact text block for the copilot's
    system prompt, plus the timeline/modulator grammar."""
    lines: list = []

    def walk(node: dict, path: str) -> None:
        props = node.get("properties")
        if props is not None:
            for key, sub in props.items():
                walk(sub, f"{path}.{key}" if path else key)
            return
        ap = node.get("additionalProperties")
        if isinstance(ap, dict):                # dict-of-X (palettes, prompts)
            if ap.get("properties"):
                walk(ap, path + ".<name>")
            else:                               # plain values: keep it short
                lines.append(_leaf_line(path + ".<name>",
                                        {"ui": node.get("ui", {})}))
            return
        items = node.get("items")
        if isinstance(items, dict) and items.get("properties"):
            walk(items, path + "[]")            # list of objects (emitters...)
            return
        lines.append(_leaf_line(path, node))

    walk(recipe_schema(), "")
    return "\n".join(lines) + "\n\n" + TIMELINE_DOC + "\n\n" + MODULATOR_DOC
