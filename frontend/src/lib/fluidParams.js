// AUTO-GENERATED from backend/animation_params.py (FLUID_PARAM_SPEC,
// COLOR_PARAM_SPEC, SOURCE_PARAM_SPEC). Do NOT edit by hand — run `python -m
// backend.gen_fluid_params` (or `make gen-params`) and commit the result. A pytest
// asserts this file matches the specs.
//
// Native-unit ranges/defaults + UI metadata (label/step/group/fmt) for every
// modulatable port: the fluid card (01 §3.5), the color (dye) card, and the
// source layer cards (lyrics / image / video / backdrop).

const fmtFixed = (n) => (v) => v.toFixed(n);
const fmtDeg = (v) => `${v | 0}°`;

export const FLUID_PARAMS = [
  { key: "emit", label: "emit", min: 0, max: 1, step: 0.02, def: 0.3, group: "source", fmt: fmtFixed(2) },
  { key: "radius", label: "radius", min: 0.02, max: 0.3, step: 0.01, def: 0.08, group: "source", fmt: fmtFixed(2) },
  { key: "force", label: "force", min: 0, max: 60, step: 1, def: 20, group: "source" },
  { key: "angle", label: "angle", min: 0, max: 360, step: 5, def: 270, group: "source", fmt: fmtDeg },
  { key: "dissipation", label: "dissip.", min: 0.85, max: 0.995, step: 0.005, def: 0.95, group: "medium", fmt: fmtFixed(3) },
  { key: "velocity_dissipation", label: "vel diss.", min: 0.85, max: 0.995, step: 0.005, def: 0.97, group: "medium", fmt: fmtFixed(3) },
  { key: "viscosity", label: "viscosity", min: 0, max: 0.5, step: 0.02, def: 0, group: "medium", fmt: fmtFixed(2) },
  { key: "vorticity", label: "vorticity", min: 0, max: 10, step: 0.5, def: 6, group: "medium", fmt: fmtFixed(1) },
];

export const FLUID_PARAM_KEYS = FLUID_PARAMS.map((p) => p.key);

export const fluidParam = (k) => FLUID_PARAMS.find((p) => p.key === k);

// The color (dye) card's modulatable ports.
export const COLOR_PARAMS = [
  { key: "r", label: "red", min: 0, max: 1, step: 0.01, def: 0.27, group: "color", fmt: fmtFixed(2) },
  { key: "g", label: "green", min: 0, max: 1, step: 0.01, def: 0.69, group: "color", fmt: fmtFixed(2) },
  { key: "b", label: "blue", min: 0, max: 1, step: 0.01, def: 1, group: "color", fmt: fmtFixed(2) },
  { key: "intensity", label: "intensity", min: 0, max: 3, step: 0.1, def: 1, group: "color", fmt: fmtFixed(1) },
  { key: "opacity", label: "opacity", min: 0, max: 1, step: 0.05, def: 1, group: "color", fmt: fmtFixed(2) },
  { key: "position", label: "position", min: 0, max: 1, step: 0.01, def: 0, group: "color", fmt: fmtFixed(2) },
];

// Per source-card modulatable ports (lyrics / image / video / backdrop).
export const SOURCE_PARAMS = {
  "lyrics": [
    { key: "opacity", label: "opacity", min: 0, max: 1, step: 0.01, def: 1, group: "src", fmt: fmtFixed(2) },
  ],
  "image": [
    { key: "opacity", label: "opacity", min: 0, max: 1, step: 0.01, def: 1, group: "src", fmt: fmtFixed(2) },
  ],
  "slideshow": [
    { key: "opacity", label: "opacity", min: 0, max: 1, step: 0.01, def: 1, group: "src", fmt: fmtFixed(2) },
    { key: "trigger", label: "trigger", min: 0, max: 1, step: 0.01, def: 0, group: "src", fmt: fmtFixed(2) },
  ],
  "video": [
    { key: "opacity", label: "opacity", min: 0, max: 1, step: 0.01, def: 1, group: "src", fmt: fmtFixed(2) },
    { key: "speed", label: "speed", min: 0, max: 4, step: 0.05, def: 1, group: "src", fmt: fmtFixed(2) },
  ],
  "backdrop": [
    { key: "opacity", label: "opacity", min: 0, max: 1, step: 0.01, def: 1, group: "src", fmt: fmtFixed(2) },
  ],
  "transform": [
    { key: "zoom", label: "zoom", min: 0.5, max: 2, step: 0.01, def: 1, group: "src", fmt: fmtFixed(2) },
    { key: "rotate", label: "rotate", min: 0, max: 360, step: 1, def: 0, group: "src", fmt: fmtDeg },
    { key: "pan_x", label: "pan x", min: -0.5, max: 0.5, step: 0.01, def: 0, group: "src", fmt: fmtFixed(2) },
    { key: "pan_y", label: "pan y", min: -0.5, max: 0.5, step: 0.01, def: 0, group: "src", fmt: fmtFixed(2) },
  ],
  "stylize": [
    { key: "strength", label: "strength", min: 0, max: 1, step: 0.01, def: 1, group: "src", fmt: fmtFixed(2) },
  ],
};
