"""Fluid param spec — the shared source of truth for the graph executor.

This mirrors the canonical table in `specs/create-animation/01-data-model.md` §3.5
(itself derived from `FluidLab.jsx`). It is the single Python-side definition of
which fluid params are modulatable, their native-unit ranges/defaults, and where
each key nests inside the `simulate()` params dict (`source.*` vs `fluid.*`).

The frontend keeps an identical table in `frontend/src/lib/fluidParams.js`; a test
(`09`) asserts the key sets match. Kept as a separate importable module so tests
can build/validate params without spinning up Flask.
"""
from __future__ import annotations

# key -> (nested_group, min, max, default)
#   nested_group in {"source", "fluid"} — where simulate() reads the key.
#   min/max are the native-unit bounds; default is the native-unit fallback used
#   when a port has no binding.
PARAMS: dict[str, tuple[str, float, float, float]] = {
    "emit": ("source", 0.0, 1.0, 0.30),
    "radius": ("source", 0.02, 0.3, 0.08),
    "force": ("source", 0.0, 60.0, 20.0),
    "angle": ("source", 0.0, 360.0, 270.0),
    "intensity": ("source", 0.0, 3.0, 1.0),
    "opacity": ("source", 0.0, 1.0, 1.0),
    # Per-channel dye colour (0..1). Modulatable so a signal/pulse can drive hue,
    # not just brightness. simulate() falls back to the static `color` vector for
    # any channel left unset (keeps the FluidLab `/fluid` path scalar-only).
    "r": ("source", 0.0, 1.0, 0.27),
    "g": ("source", 0.0, 1.0, 0.69),
    "b": ("source", 0.0, 1.0, 1.0),
    "dissipation": ("fluid", 0.85, 0.995, 0.95),
    "velocity_dissipation": ("fluid", 0.85, 0.995, 0.97),
    "viscosity": ("fluid", 0.0, 0.5, 0.0),
    "vorticity": ("fluid", 0.0, 10.0, 6.0),
}

# Static params (not ports in v1; set on the fluid card) and where they nest.
# `duration`, `fps`, `grid` live at the top level of the params dict; the rest are
# nested under `source.*` in simulate(). Color/path are deliberately static in v1.
SOURCE_STATIC_KEYS: tuple[str, ...] = (
    "color", "enabled", "radial", "wrap", "points",
    "path_speed", "path_closed", "path_pingpong",
)

# Project-level OUTPUT render settings (not modulatable ports; one shared object
# per project, edited in the animation settings modal and persisted in the project
# JSONB). Threaded into the simulate() params as a top-level `output` dict, where
# they drive the rectangular grid (via fluid.grid_from_output), fps, and the
# background composite. Keys + defaults:
#   width/height (px) — output size; orientation is implied by which is larger.
#   quality          — "draft"|"normal"|"high" -> short-side sim cells (fluid._QUALITY_CELLS).
#   fps              — frames per second of the encoded clip.
#   background       — solid background color (hex) composited behind the dye.
OUTPUT_DEFAULTS: dict = {
    "width": 1080, "height": 1920, "quality": "normal",
    "fps": 24, "background": "#000000",
}
