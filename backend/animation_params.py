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
    {
        "key": "r",
        "label": "red",
        "min": 0.0,
        "max": 1.0,
        "step": 0.01,
        "default": 0.27,
        "fmt": "dp2",
    },
    {
        "key": "g",
        "label": "green",
        "min": 0.0,
        "max": 1.0,
        "step": 0.01,
        "default": 0.69,
        "fmt": "dp2",
    },
    {
        "key": "b",
        "label": "blue",
        "min": 0.0,
        "max": 1.0,
        "step": 0.01,
        "default": 1.0,
        "fmt": "dp2",
    },
    {
        "key": "intensity",
        "label": "intensity",
        "min": 0.0,
        "max": 3.0,
        "step": 0.1,
        "default": 1.0,
        "fmt": "dp1",
    },
    {
        "key": "opacity",
        "label": "opacity",
        "min": 0.0,
        "max": 1.0,
        "step": 0.05,
        "default": 1.0,
        "fmt": "dp2",
    },
    # gradient mode: 0..1 sample point along the colour stops (modulatable — wire an
    # LFO/signal to sweep the colour). Ignored in swatch / rgb mode.
    {
        "key": "position",
        "label": "position",
        "min": 0.0,
        "max": 1.0,
        "step": 0.01,
        "default": 0.0,
        "fmt": "dp2",
    },
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
def _p(
    key: str,
    lo: float,
    hi: float,
    default: float,
    *,
    step: float = 0.01,
    fmt: str = "dp2",
    label: str | None = None,
) -> dict:
    """One modulatable-port spec row.

    77 of these were written out as 9-line dict literals with an identical key set, so
    the table was ~680 lines of punctuation around ~77 lines of actual numbers. The
    defaults are the common case (0..1, step 0.01, 2dp) and `label` falls back to the key
    with underscores spaced out — the form every label but one already used.

    Safe to refactor because `tests/test_fluid_params_codegen.py` compares the GENERATED
    frontend table byte-for-byte: if any value moved, the generated file changes and the
    test fails. `_opacity_spec` below is the pattern this generalises.
    """
    return {
        "key": key,
        "label": key.replace("_", " ") if label is None else label,
        "min": lo,
        "max": hi,
        "step": step,
        "default": default,
        "fmt": fmt,
    }


def _opacity_spec(step: float = 0.01) -> dict:
    return {
        "key": "opacity",
        "label": "opacity",
        "min": 0.0,
        "max": 1.0,
        "step": step,
        "default": 1.0,
        "fmt": "dp2",
    }


SOURCE_PARAM_SPEC: dict[str, list[dict]] = {
    # The lyrics fill/outline colours come from wired `color` cards and the text box
    # defines size/placement, so `opacity` is the only modulatable port. Image is a
    # static asset in a box — likewise. Video adds `speed` (the source advances by
    # speed/fps each frame, so a wired signal time-warps the clip).
    "lyrics": [_opacity_spec()],
    "text": [_opacity_spec()],
    "image": [_opacity_spec()],
    # The slideshow layer: `trigger` advances to the next image on each rising edge
    # past the card's built-in hysteresis threshold (see graph_render._slideshow_*).
    "slideshow": [
        _opacity_spec(),
        _p("trigger", 0, 1, 0),
    ],
    "video": [
        _opacity_spec(),
        _p("speed", 0, 4, 1, step=0.05),
    ],
    # The montage switcher (N wired video slots -> one video): each rising edge of
    # `trigger` past the card's built-in hysteresis threshold cuts to the NEXT slot
    # (see graph_render._montage_*). Not a source (it has video inputs) but its
    # ports resolve exactly like one, so it shares this table.
    "montage": [
        _opacity_spec(),
        _p("trigger", 0, 1, 0),
    ],
    "backdrop": [_opacity_spec()],
    # The `transform` video-FX card (video -> video): an affine warp of the incoming
    # frames, plus mirror / kaleidoscope folds. Not a source (it has a video input),
    # but its ports resolve exactly like one, so it shares this table.
    "transform": [
        _p("zoom", 0.5, 2, 1),
        _p("rotate", 0, 360, 0, step=1, fmt="deg"),
        _p("pan_x", -0.5, 0.5, 0),
        _p("pan_y", -0.5, 0.5, 0),
    ],
    # The Echo look-FX card (video -> video): motion trails via a decayed running max
    # (specs/look-fx/01-echo.md). `length` is the trail half-life in seconds (0 = off);
    # `amount` mixes dry <-> trailed. Wire `length` to a signal for beat-pumped trails.
    "echo": [
        _p("length", 0, 2, 0.4, step=0.05),
        _p("amount", 0, 1, 1),
    ],
    # The Color Grade look-FX card (video -> video): thermal / duotone / neon recolour
    # (specs/look-fx/02-color-grade.md). `intensity` mixes dry <-> graded (neon: glow
    # gain); `shift` rolls the thermal LUT / shapes the duotone midpoint / rotates the
    # neon hue. mode/map/colorA/colorB are static `data` fields; `tint` is a colour input.
    "colorgrade": [
        _p("intensity", 0, 1, 1),
        _p("shift", 0, 1, 0),
    ],
    # The AI Stylize card (video -> video): img2img of the upstream fluid toward a prompt.
    # `strength` is the img2img denoise curseur (0 = keep the fluid, 1 = fully reinvent);
    # modulatable so a signal can drive it. mode/model/prompt are static `data` fields.
    "stylize": [
        # default 1.0: SD-Turbo's strength is near-binary — below ~0.9 keeps the input's
        # colours (subtle blend), 1.0 fully restyles to the prompt (real flowers/lava).
        _p("strength", 0, 1, 1),
    ],
    # ── Generative SIMULATION cards (specs/generative-cards/) — real 2-D physics
    # (wave optics / Laplacian growth / buoyant combustion / wave equation /
    # volumetric lighting), signal-reactive per port. Colour is a static `palette`
    # select + an optional wired `color` card override (both static `data`, not
    # ports). Waves/rain also take an optional `video` input they REFRACT.
    # Waves: pool water — directional wave spectrum (deep-water dispersion),
    # Jacobian caustics, refraction of the input, sun glint.
    "waves": [
        _p("scale", 0, 1, 0.5),
        _p("steepness", 0, 1, 0.45),
        _p("depth", 0, 1, 0.5),
        _p("speed", 0, 3, 1, step=0.05),
        _p("direction", 0, 360, 30, step=1, fmt="deg"),
        _p("caustics", 0, 1, 0.6),
        _p("chroma", 0, 1, 0.35),
        _p("shine", 0, 1, 0.4),
        _opacity_spec(),
    ],
    # Lightning: dielectric-breakdown bolts struck on a `strike` rising edge, from
    # (`origin_x`, `origin_y`) toward `direction`, with dart-leader restrikes
    # (`flicker`), origin-centred sky `flash` and continuing-current `afterglow`.
    "lightning": [
        _p("strike", 0, 1, 0),
        _p("origin_x", 0, 1, 0.5),
        _p("origin_y", 0, 1, 0.08),
        _p("direction", 0, 360, 90, step=1, fmt="deg"),
        _p("length", 0.1, 1.5, 0.8),
        _p("branchiness", 0, 1, 0.55, label="branches"),
        _p("thickness", 0.5, 6, 2.2, step=0.1, fmt="dp1"),
        _p("glow", 0, 1, 0.6),
        _p("flicker", 0, 1, 0.6),
        _p("flash", 0, 1, 0.35),
        _p("afterglow", 0, 1, 0.5),
        _opacity_spec(),
    ],
    # Fire: buoyant combustion on the fluid solver — heat emitter at
    # (`origin_x`, `origin_y`), buoyancy along `direction` (270 = up), quartic
    # `cooling` = flame height, `turbulence` = vorticity confinement, blackbody
    # rendering. Rides the fluid render/cache path (fluid.FireSim mode).
    "fire": [
        _p("origin_x", 0, 1, 0.5),
        _p("origin_y", 0, 1, 0.85),
        _p("direction", 0, 360, 270, step=1, fmt="deg"),
        _p("intensity", 0, 1, 0.9),
        _p("width", 0, 1, 0.5),
        _p("cooling", 0, 1, 0.6),
        _p("turbulence", 0, 1, 0.6),
        _p("flicker", 0, 1, 0.5),
        _p("expansion", 0, 1, 0.4),
        _p("glow", 0, 1, 0.5),
        _opacity_spec(),
    ],
    # Aurora: horizontal arcs (`position_y`) with Chapman-layer rays (`height`),
    # ray intensities crossfading at `shimmer`, arcs folding with `sway` and
    # sliding with `drift`. Altitude-stratified palette colours.
    "aurora": [
        _p("position_y", 0, 1, 0.3),
        _p("height", 0, 1, 0.5),
        _p("bands", 1, 5, 2, step=1, fmt="dp1"),
        _p("sway", 0, 1, 0.4),
        _p("drift", 0, 1, 0.3),
        _p("shimmer", 0, 1, 0.5),
        _p("rays", 0, 1, 0.5),
        _p("brightness", 0, 1, 0.65),
        _opacity_spec(),
    ],
    # Rain: drops on a liquid surface — spectral wave-equation rings (capillary
    # dispersion) refracting the input. `density` = drops/s, `decay` = ring life,
    # `distort` = refraction strength, `shine` = specular glints.
    "rain": [
        _p("density", 0, 1, 0.5),
        _p("drop_size", 0, 1, 0.5),
        _p("ripple_speed", 0.1, 3, 1, step=0.05),
        _p("decay", 0, 1, 0.7),
        _p("distort", 0, 1, 0.6),
        _p("shine", 0, 1, 0.5),
        _opacity_spec(),
    ],
    # Clouds: billow/warp/erosion density with a Beer-Lambert sun march,
    # powder term and silver lining. `light_angle` places the sun; `shading`
    # scales the self-shadowing; densities of merged cards share one sun.
    "clouds": [
        _p("coverage", 0, 1, 0.5),
        _p("scale", 0, 1, 0.5),
        _p("softness", 0, 1, 0.5),
        _p("drift", 0, 2, 0.5, step=0.05),
        _p("direction", 0, 360, 15, step=1, fmt="deg"),
        _p("turbulence", 0, 1, 0.5),
        _p("light_angle", 0, 360, 300, step=1, fmt="deg"),
        _p("shading", 0, 1, 0.6),
        _p("silver", 0, 1, 0.4),
        _p("brightness", 0, 1, 0.65),
        _opacity_spec(),
    ],
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
