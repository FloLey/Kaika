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

# THE source of truth for the fluid param spec. Each entry carries both the
# simulate() contract (sim_group/min/max/default) and the UI metadata the frontend
# needs (label, slider step, display group, value formatter). The frontend
# `fluidParams.js` is GENERATED from this table (`python -m backend.gen_fluid_params`),
# so there is no hand-maintained mirror to drift — a pytest asserts the committed
# file matches (see tests/test_fluid_params_codegen.py).
#
# Fields:
#   sim_group  — "source" | "fluid": where simulate() reads the key.
#   ui_group   — "source" | "color" | "medium": how the card groups the control.
#   label      — control label shown in the UI.
#   min/max    — native-unit bounds.  step — slider granularity.  default — fallback.
#   fmt        — value formatter token: "dp1"/"dp2"/"dp3" (toFixed) | "deg" | None.
FLUID_PARAM_SPEC: list[dict] = [
    {
        "key": "emit",
        "sim_group": "source",
        "ui_group": "source",
        "label": "emit",
        "min": 0.0,
        "max": 1.0,
        "step": 0.02,
        "default": 0.30,
        "fmt": "dp2",
    },
    {
        "key": "radius",
        "sim_group": "source",
        "ui_group": "source",
        "label": "radius",
        "min": 0.02,
        "max": 0.3,
        "step": 0.01,
        "default": 0.08,
        "fmt": "dp2",
    },
    {
        "key": "force",
        "sim_group": "source",
        "ui_group": "source",
        "label": "force",
        "min": 0.0,
        "max": 60.0,
        "step": 1.0,
        "default": 20.0,
        "fmt": None,
    },
    {
        "key": "angle",
        "sim_group": "source",
        "ui_group": "source",
        "label": "angle",
        "min": 0.0,
        "max": 360.0,
        "step": 5.0,
        "default": 270.0,
        "fmt": "deg",
    },
    # NOTE: the per-channel dye colour (r/g/b/intensity/opacity) USED to live here as
    # fluid ports. It was extracted into its own `color` card (COLOR_PARAM_SPEC below),
    # wired into the fluid's `color` input — so the fluid spec is now source + medium only.
    {
        "key": "dissipation",
        "sim_group": "fluid",
        "ui_group": "medium",
        "label": "dissip.",
        "min": 0.85,
        "max": 0.995,
        "step": 0.005,
        "default": 0.95,
        "fmt": "dp3",
    },
    {
        "key": "velocity_dissipation",
        "sim_group": "fluid",
        "ui_group": "medium",
        "label": "vel diss.",
        "min": 0.85,
        "max": 0.995,
        "step": 0.005,
        "default": 0.97,
        "fmt": "dp3",
    },
    {
        "key": "viscosity",
        "sim_group": "fluid",
        "ui_group": "medium",
        "label": "viscosity",
        "min": 0.0,
        "max": 0.5,
        "step": 0.02,
        "default": 0.0,
        "fmt": "dp2",
    },
    {
        "key": "vorticity",
        "sim_group": "fluid",
        "ui_group": "medium",
        "label": "vorticity",
        "min": 0.0,
        "max": 10.0,
        "step": 0.5,
        "default": 6.0,
        "fmt": "dp1",
    },
]

# key -> (sim_group, min, max, default), derived from the spec. The graph executor
# reads this compact view; min/max are the native-unit bounds; default is the
# native-unit fallback used when a port has no binding.
PARAMS: dict[str, tuple[str, float, float, float]] = {
    p["key"]: (p["sim_group"], p["min"], p["max"], p["default"]) for p in FLUID_PARAM_SPEC
}

# The dye-colour params, extracted from the fluid into a standalone `color` card
# (wired into the fluid's `color` input). Same native-unit ranges/defaults the fluid
# used to carry; all nest under simulate()'s `source.*`. r/g/b are a swatch in the UI;
# intensity/opacity stay modulatable ports. When no color card is wired the fluid
# falls back to its static `color` vector (+ simulate's intensity/opacity defaults).
COLOR_PARAM_SPEC: list[dict] = [
    {"key": "r", "label": "red", "min": 0.0, "max": 1.0, "step": 0.01, "default": 0.27, "fmt": "dp2"},
    {"key": "g", "label": "green", "min": 0.0, "max": 1.0, "step": 0.01, "default": 0.69, "fmt": "dp2"},
    {"key": "b", "label": "blue", "min": 0.0, "max": 1.0, "step": 0.01, "default": 1.0, "fmt": "dp2"},
    {"key": "intensity", "label": "intensity", "min": 0.0, "max": 3.0, "step": 0.1, "default": 1.0, "fmt": "dp1"},
    {"key": "opacity", "label": "opacity", "min": 0.0, "max": 1.0, "step": 0.05, "default": 1.0, "fmt": "dp2"},
    # gradient mode: 0..1 sample point along the colour stops (modulatable — wire an
    # LFO/signal to sweep the colour). Ignored in swatch / rgb mode.
    {"key": "position", "label": "position", "min": 0.0, "max": 1.0, "step": 0.01, "default": 0.0, "fmt": "dp2"},
]

# key -> (min, max, default) for the color card's ports. Same shape as the source
# port specs (sources.SOURCE_PARAMS) so the graph executor resolves a color port
# exactly like any other modulatable port. All color keys nest under source.
COLOR_PARAMS: dict[str, tuple[float, float, float]] = {
    p["key"]: (p["min"], p["max"], p["default"]) for p in COLOR_PARAM_SPEC
}

# Rich per-card port specs for the non-fluid SOURCE cards (lyrics / image / video /
# backdrop). Same pattern as FLUID_PARAM_SPEC: this is the single source of truth —
# min/max/default feed the executor's compact view (sources.SOURCE_PARAMS) and
# label/step/fmt feed the GENERATED frontend table (gen_fluid_params -> nodeParams),
# so the UI ranges can never drift from what the render maps.
def _opacity_spec(step: float = 0.01) -> dict:
    return {"key": "opacity", "label": "opacity", "min": 0.0, "max": 1.0,
            "step": step, "default": 1.0, "fmt": "dp2"}


SOURCE_PARAM_SPEC: dict[str, list[dict]] = {
    # The lyrics fill/outline colours come from wired `color` cards and the text box
    # defines size/placement, so `opacity` is the only modulatable port. Image is a
    # static asset in a box — likewise. Video adds `speed` (the source advances by
    # speed/fps each frame, so a wired signal time-warps the clip).
    "lyrics": [_opacity_spec()],
    "image": [_opacity_spec()],
    # The slideshow layer: `trigger` advances to the next image on each rising edge
    # past the card's built-in hysteresis threshold (see graph_render._imagegen_*).
    "imagegen": [
        _opacity_spec(),
        {"key": "trigger", "label": "trigger", "min": 0.0, "max": 1.0, "step": 0.01,
         "default": 0.0, "fmt": "dp2"},
    ],
    "video": [
        _opacity_spec(),
        {"key": "speed", "label": "speed", "min": 0.0, "max": 4.0, "step": 0.05,
         "default": 1.0, "fmt": "dp2"},
    ],
    "backdrop": [_opacity_spec()],
}

# Static params (not ports in v1; set on the fluid card) and where they nest.
# `duration`, `fps`, `grid` live at the top level of the params dict; the rest are
# nested under `source.*` in simulate(). Color/path are deliberately static in v1.
SOURCE_STATIC_KEYS: tuple[str, ...] = (
    "color",
    "enabled",
    "radial",
    "wrap",
    "points",
    "path_speed",
    "path_closed",
    "path_pingpong",
)

# Project-level OUTPUT render settings (not modulatable ports; one shared object
# per project, edited in the animation settings modal and persisted in the project
# JSONB). Threaded into the simulate() params as a top-level `output` dict, where
# they drive the rectangular grid (via fluid.grid_from_output) and fps. There is no
# background setting — un-dyed pixels are black; any backdrop is a bottom layer. Keys:
#   width/height (px) — output size; orientation is implied by which is larger.
#   quality          — "draft"|"normal"|"high" -> short-side sim cells (fluid._QUALITY_CELLS).
#   fps              — frames per second of the encoded clip.
OUTPUT_DEFAULTS: dict = {
    "width": 1080,
    "height": 1920,
    "quality": "normal",
    "fps": 24,
}
