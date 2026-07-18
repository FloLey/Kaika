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
    "image": [_opacity_spec()],
    # The slideshow layer: `trigger` advances to the next image on each rising edge
    # past the card's built-in hysteresis threshold (see graph_render._slideshow_*).
    "slideshow": [
        _opacity_spec(),
        {
            "key": "trigger",
            "label": "trigger",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.0,
            "fmt": "dp2",
        },
    ],
    "video": [
        _opacity_spec(),
        {
            "key": "speed",
            "label": "speed",
            "min": 0.0,
            "max": 4.0,
            "step": 0.05,
            "default": 1.0,
            "fmt": "dp2",
        },
    ],
    "backdrop": [_opacity_spec()],
    # The `transform` video-FX card (video -> video): an affine warp of the incoming
    # frames, plus mirror / kaleidoscope folds. Not a source (it has a video input),
    # but its ports resolve exactly like one, so it shares this table.
    "transform": [
        {
            "key": "zoom",
            "label": "zoom",
            "min": 0.5,
            "max": 2.0,
            "step": 0.01,
            "default": 1.0,
            "fmt": "dp2",
        },
        {
            "key": "rotate",
            "label": "rotate",
            "min": 0.0,
            "max": 360.0,
            "step": 1.0,
            "default": 0.0,
            "fmt": "deg",
        },
        {
            "key": "pan_x",
            "label": "pan x",
            "min": -0.5,
            "max": 0.5,
            "step": 0.01,
            "default": 0.0,
            "fmt": "dp2",
        },
        {
            "key": "pan_y",
            "label": "pan y",
            "min": -0.5,
            "max": 0.5,
            "step": 0.01,
            "default": 0.0,
            "fmt": "dp2",
        },
    ],
    # The Echo look-FX card (video -> video): motion trails via a decayed running max
    # (specs/look-fx/01-echo.md). `length` is the trail half-life in seconds (0 = off);
    # `amount` mixes dry <-> trailed. Wire `length` to a signal for beat-pumped trails.
    "echo": [
        {
            "key": "length",
            "label": "length",
            "min": 0.0,
            "max": 2.0,
            "step": 0.05,
            "default": 0.4,
            "fmt": "dp2",
        },
        {
            "key": "amount",
            "label": "amount",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 1.0,
            "fmt": "dp2",
        },
    ],
    # The Color Grade look-FX card (video -> video): thermal / duotone / neon recolour
    # (specs/look-fx/02-color-grade.md). `intensity` mixes dry <-> graded (neon: glow
    # gain); `shift` rolls the thermal LUT / shapes the duotone midpoint / rotates the
    # neon hue. mode/map/colorA/colorB are static `data` fields; `tint` is a colour input.
    "colorgrade": [
        {
            "key": "intensity",
            "label": "intensity",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 1.0,
            "fmt": "dp2",
        },
        {
            "key": "shift",
            "label": "shift",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.0,
            "fmt": "dp2",
        },
    ],
    # The AI Stylize card (video -> video): img2img of the upstream fluid toward a prompt.
    # `strength` is the img2img denoise curseur (0 = keep the fluid, 1 = fully reinvent);
    # modulatable so a signal can drive it. mode/model/prompt are static `data` fields.
    "stylize": [
        # default 1.0: SD-Turbo's strength is near-binary — below ~0.9 keeps the input's
        # colours (subtle blend), 1.0 fully restyles to the prompt (real flowers/lava).
        {
            "key": "strength",
            "label": "strength",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 1.0,
            "fmt": "dp2",
        },
    ],
    # ── Generative SIMULATION cards (docs/generative-cards/) — real 2-D physics
    # (wave optics / Laplacian growth / buoyant combustion / wave equation /
    # volumetric lighting), signal-reactive per port. Colour is a static `palette`
    # select + an optional wired `color` card override (both static `data`, not
    # ports). Waves/rain also take an optional `video` input they REFRACT.
    # Waves: pool water — directional wave spectrum (deep-water dispersion),
    # Jacobian caustics, refraction of the input, sun glint.
    "waves": [
        {
            "key": "scale",
            "label": "scale",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.5,
            "fmt": "dp2",
        },
        {
            "key": "steepness",
            "label": "steepness",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.45,
            "fmt": "dp2",
        },
        {
            "key": "depth",
            "label": "depth",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.5,
            "fmt": "dp2",
        },
        {
            "key": "speed",
            "label": "speed",
            "min": 0.0,
            "max": 3.0,
            "step": 0.05,
            "default": 1.0,
            "fmt": "dp2",
        },
        {
            "key": "direction",
            "label": "direction",
            "min": 0.0,
            "max": 360.0,
            "step": 1.0,
            "default": 30.0,
            "fmt": "deg",
        },
        {
            "key": "caustics",
            "label": "caustics",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.6,
            "fmt": "dp2",
        },
        {
            "key": "chroma",
            "label": "chroma",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.35,
            "fmt": "dp2",
        },
        {
            "key": "shine",
            "label": "shine",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.4,
            "fmt": "dp2",
        },
        _opacity_spec(),
    ],
    # Lightning: dielectric-breakdown bolts struck on a `strike` rising edge, from
    # (`origin_x`, `origin_y`) toward `direction`, with dart-leader restrikes
    # (`flicker`), origin-centred sky `flash` and continuing-current `afterglow`.
    "lightning": [
        {
            "key": "strike",
            "label": "strike",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.0,
            "fmt": "dp2",
        },
        {
            "key": "origin_x",
            "label": "origin x",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.5,
            "fmt": "dp2",
        },
        {
            "key": "origin_y",
            "label": "origin y",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.08,
            "fmt": "dp2",
        },
        {
            "key": "direction",
            "label": "direction",
            "min": 0.0,
            "max": 360.0,
            "step": 1.0,
            "default": 90.0,
            "fmt": "deg",
        },
        {
            "key": "length",
            "label": "length",
            "min": 0.1,
            "max": 1.5,
            "step": 0.01,
            "default": 0.8,
            "fmt": "dp2",
        },
        {
            "key": "branchiness",
            "label": "branches",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.55,
            "fmt": "dp2",
        },
        {
            "key": "thickness",
            "label": "thickness",
            "min": 0.5,
            "max": 6.0,
            "step": 0.1,
            "default": 2.2,
            "fmt": "dp1",
        },
        {
            "key": "glow",
            "label": "glow",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.6,
            "fmt": "dp2",
        },
        {
            "key": "flicker",
            "label": "flicker",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.6,
            "fmt": "dp2",
        },
        {
            "key": "flash",
            "label": "flash",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.35,
            "fmt": "dp2",
        },
        {
            "key": "afterglow",
            "label": "afterglow",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.5,
            "fmt": "dp2",
        },
        _opacity_spec(),
    ],
    # Fire: buoyant combustion on the fluid solver — heat emitter at
    # (`origin_x`, `origin_y`), buoyancy along `direction` (270 = up), quartic
    # `cooling` = flame height, `turbulence` = vorticity confinement, blackbody
    # rendering. Rides the fluid render/cache path (fluid.FireSim mode).
    "fire": [
        {
            "key": "origin_x",
            "label": "origin x",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.5,
            "fmt": "dp2",
        },
        {
            "key": "origin_y",
            "label": "origin y",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.85,
            "fmt": "dp2",
        },
        {
            "key": "direction",
            "label": "direction",
            "min": 0.0,
            "max": 360.0,
            "step": 1.0,
            "default": 270.0,
            "fmt": "deg",
        },
        {
            "key": "intensity",
            "label": "intensity",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.9,
            "fmt": "dp2",
        },
        {
            "key": "width",
            "label": "width",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.5,
            "fmt": "dp2",
        },
        {
            "key": "cooling",
            "label": "cooling",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.6,
            "fmt": "dp2",
        },
        {
            "key": "turbulence",
            "label": "turbulence",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.6,
            "fmt": "dp2",
        },
        {
            "key": "flicker",
            "label": "flicker",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.5,
            "fmt": "dp2",
        },
        {
            "key": "expansion",
            "label": "expansion",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.4,
            "fmt": "dp2",
        },
        {
            "key": "glow",
            "label": "glow",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.5,
            "fmt": "dp2",
        },
        _opacity_spec(),
    ],
    # Aurora: horizontal arcs (`position_y`) with Chapman-layer rays (`height`),
    # ray intensities crossfading at `shimmer`, arcs folding with `sway` and
    # sliding with `drift`. Altitude-stratified palette colours.
    "aurora": [
        {
            "key": "position_y",
            "label": "position y",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.3,
            "fmt": "dp2",
        },
        {
            "key": "height",
            "label": "height",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.5,
            "fmt": "dp2",
        },
        {
            "key": "bands",
            "label": "bands",
            "min": 1.0,
            "max": 5.0,
            "step": 1.0,
            "default": 2.0,
            "fmt": "dp1",
        },
        {
            "key": "sway",
            "label": "sway",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.4,
            "fmt": "dp2",
        },
        {
            "key": "drift",
            "label": "drift",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.3,
            "fmt": "dp2",
        },
        {
            "key": "shimmer",
            "label": "shimmer",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.5,
            "fmt": "dp2",
        },
        {
            "key": "rays",
            "label": "rays",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.5,
            "fmt": "dp2",
        },
        {
            "key": "brightness",
            "label": "brightness",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.65,
            "fmt": "dp2",
        },
        _opacity_spec(),
    ],
    # Rain: drops on a liquid surface — spectral wave-equation rings (capillary
    # dispersion) refracting the input. `density` = drops/s, `decay` = ring life,
    # `distort` = refraction strength, `shine` = specular glints.
    "rain": [
        {
            "key": "density",
            "label": "density",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.5,
            "fmt": "dp2",
        },
        {
            "key": "drop_size",
            "label": "drop size",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.5,
            "fmt": "dp2",
        },
        {
            "key": "ripple_speed",
            "label": "ripple speed",
            "min": 0.1,
            "max": 3.0,
            "step": 0.05,
            "default": 1.0,
            "fmt": "dp2",
        },
        {
            "key": "decay",
            "label": "decay",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.7,
            "fmt": "dp2",
        },
        {
            "key": "distort",
            "label": "distort",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.6,
            "fmt": "dp2",
        },
        {
            "key": "shine",
            "label": "shine",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.5,
            "fmt": "dp2",
        },
        _opacity_spec(),
    ],
    # Clouds: billow/warp/erosion density with a Beer-Lambert sun march,
    # powder term and silver lining. `light_angle` places the sun; `shading`
    # scales the self-shadowing; densities of merged cards share one sun.
    "clouds": [
        {
            "key": "coverage",
            "label": "coverage",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.5,
            "fmt": "dp2",
        },
        {
            "key": "scale",
            "label": "scale",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.5,
            "fmt": "dp2",
        },
        {
            "key": "softness",
            "label": "softness",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.5,
            "fmt": "dp2",
        },
        {
            "key": "drift",
            "label": "drift",
            "min": 0.0,
            "max": 2.0,
            "step": 0.05,
            "default": 0.5,
            "fmt": "dp2",
        },
        {
            "key": "direction",
            "label": "direction",
            "min": 0.0,
            "max": 360.0,
            "step": 1.0,
            "default": 15.0,
            "fmt": "deg",
        },
        {
            "key": "turbulence",
            "label": "turbulence",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.5,
            "fmt": "dp2",
        },
        {
            "key": "light_angle",
            "label": "light angle",
            "min": 0.0,
            "max": 360.0,
            "step": 1.0,
            "default": 300.0,
            "fmt": "deg",
        },
        {
            "key": "shading",
            "label": "shading",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.6,
            "fmt": "dp2",
        },
        {
            "key": "silver",
            "label": "silver",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.4,
            "fmt": "dp2",
        },
        {
            "key": "brightness",
            "label": "brightness",
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "default": 0.65,
            "fmt": "dp2",
        },
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
