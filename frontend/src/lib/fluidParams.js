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
  "text": [
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
  "montage": [
    { key: "opacity", label: "opacity", min: 0, max: 1, step: 0.01, def: 1, group: "src", fmt: fmtFixed(2) },
    { key: "trigger", label: "trigger", min: 0, max: 1, step: 0.01, def: 0, group: "src", fmt: fmtFixed(2) },
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
  "echo": [
    { key: "length", label: "length", min: 0, max: 2, step: 0.05, def: 0.4, group: "src", fmt: fmtFixed(2) },
    { key: "amount", label: "amount", min: 0, max: 1, step: 0.01, def: 1, group: "src", fmt: fmtFixed(2) },
  ],
  "colorgrade": [
    { key: "intensity", label: "intensity", min: 0, max: 1, step: 0.01, def: 1, group: "src", fmt: fmtFixed(2) },
    { key: "shift", label: "shift", min: 0, max: 1, step: 0.01, def: 0, group: "src", fmt: fmtFixed(2) },
  ],
  "stylize": [
    { key: "strength", label: "strength", min: 0, max: 1, step: 0.01, def: 1, group: "src", fmt: fmtFixed(2) },
  ],
  "waves": [
    { key: "scale", label: "scale", min: 0, max: 1, step: 0.01, def: 0.5, group: "src", fmt: fmtFixed(2) },
    { key: "steepness", label: "steepness", min: 0, max: 1, step: 0.01, def: 0.45, group: "src", fmt: fmtFixed(2) },
    { key: "depth", label: "depth", min: 0, max: 1, step: 0.01, def: 0.5, group: "src", fmt: fmtFixed(2) },
    { key: "speed", label: "speed", min: 0, max: 3, step: 0.05, def: 1, group: "src", fmt: fmtFixed(2) },
    { key: "direction", label: "direction", min: 0, max: 360, step: 1, def: 30, group: "src", fmt: fmtDeg },
    { key: "caustics", label: "caustics", min: 0, max: 1, step: 0.01, def: 0.6, group: "src", fmt: fmtFixed(2) },
    { key: "chroma", label: "chroma", min: 0, max: 1, step: 0.01, def: 0.35, group: "src", fmt: fmtFixed(2) },
    { key: "shine", label: "shine", min: 0, max: 1, step: 0.01, def: 0.4, group: "src", fmt: fmtFixed(2) },
    { key: "opacity", label: "opacity", min: 0, max: 1, step: 0.01, def: 1, group: "src", fmt: fmtFixed(2) },
  ],
  "lightning": [
    { key: "strike", label: "strike", min: 0, max: 1, step: 0.01, def: 0, group: "src", fmt: fmtFixed(2) },
    { key: "origin_x", label: "origin x", min: 0, max: 1, step: 0.01, def: 0.5, group: "src", fmt: fmtFixed(2) },
    { key: "origin_y", label: "origin y", min: 0, max: 1, step: 0.01, def: 0.08, group: "src", fmt: fmtFixed(2) },
    { key: "direction", label: "direction", min: 0, max: 360, step: 1, def: 90, group: "src", fmt: fmtDeg },
    { key: "length", label: "length", min: 0.1, max: 1.5, step: 0.01, def: 0.8, group: "src", fmt: fmtFixed(2) },
    { key: "branchiness", label: "branches", min: 0, max: 1, step: 0.01, def: 0.55, group: "src", fmt: fmtFixed(2) },
    { key: "thickness", label: "thickness", min: 0.5, max: 6, step: 0.1, def: 2.2, group: "src", fmt: fmtFixed(1) },
    { key: "glow", label: "glow", min: 0, max: 1, step: 0.01, def: 0.6, group: "src", fmt: fmtFixed(2) },
    { key: "flicker", label: "flicker", min: 0, max: 1, step: 0.01, def: 0.6, group: "src", fmt: fmtFixed(2) },
    { key: "flash", label: "flash", min: 0, max: 1, step: 0.01, def: 0.35, group: "src", fmt: fmtFixed(2) },
    { key: "afterglow", label: "afterglow", min: 0, max: 1, step: 0.01, def: 0.5, group: "src", fmt: fmtFixed(2) },
    { key: "opacity", label: "opacity", min: 0, max: 1, step: 0.01, def: 1, group: "src", fmt: fmtFixed(2) },
  ],
  "fire": [
    { key: "origin_x", label: "origin x", min: 0, max: 1, step: 0.01, def: 0.5, group: "src", fmt: fmtFixed(2) },
    { key: "origin_y", label: "origin y", min: 0, max: 1, step: 0.01, def: 0.85, group: "src", fmt: fmtFixed(2) },
    { key: "direction", label: "direction", min: 0, max: 360, step: 1, def: 270, group: "src", fmt: fmtDeg },
    { key: "intensity", label: "intensity", min: 0, max: 1, step: 0.01, def: 0.9, group: "src", fmt: fmtFixed(2) },
    { key: "width", label: "width", min: 0, max: 1, step: 0.01, def: 0.5, group: "src", fmt: fmtFixed(2) },
    { key: "cooling", label: "cooling", min: 0, max: 1, step: 0.01, def: 0.6, group: "src", fmt: fmtFixed(2) },
    { key: "turbulence", label: "turbulence", min: 0, max: 1, step: 0.01, def: 0.6, group: "src", fmt: fmtFixed(2) },
    { key: "flicker", label: "flicker", min: 0, max: 1, step: 0.01, def: 0.5, group: "src", fmt: fmtFixed(2) },
    { key: "expansion", label: "expansion", min: 0, max: 1, step: 0.01, def: 0.4, group: "src", fmt: fmtFixed(2) },
    { key: "glow", label: "glow", min: 0, max: 1, step: 0.01, def: 0.5, group: "src", fmt: fmtFixed(2) },
    { key: "opacity", label: "opacity", min: 0, max: 1, step: 0.01, def: 1, group: "src", fmt: fmtFixed(2) },
  ],
  "aurora": [
    { key: "position_y", label: "position y", min: 0, max: 1, step: 0.01, def: 0.3, group: "src", fmt: fmtFixed(2) },
    { key: "height", label: "height", min: 0, max: 1, step: 0.01, def: 0.5, group: "src", fmt: fmtFixed(2) },
    { key: "bands", label: "bands", min: 1, max: 5, step: 1, def: 2, group: "src", fmt: fmtFixed(1) },
    { key: "sway", label: "sway", min: 0, max: 1, step: 0.01, def: 0.4, group: "src", fmt: fmtFixed(2) },
    { key: "drift", label: "drift", min: 0, max: 1, step: 0.01, def: 0.3, group: "src", fmt: fmtFixed(2) },
    { key: "shimmer", label: "shimmer", min: 0, max: 1, step: 0.01, def: 0.5, group: "src", fmt: fmtFixed(2) },
    { key: "rays", label: "rays", min: 0, max: 1, step: 0.01, def: 0.5, group: "src", fmt: fmtFixed(2) },
    { key: "brightness", label: "brightness", min: 0, max: 1, step: 0.01, def: 0.65, group: "src", fmt: fmtFixed(2) },
    { key: "opacity", label: "opacity", min: 0, max: 1, step: 0.01, def: 1, group: "src", fmt: fmtFixed(2) },
  ],
  "rain": [
    { key: "density", label: "density", min: 0, max: 1, step: 0.01, def: 0.5, group: "src", fmt: fmtFixed(2) },
    { key: "drop_size", label: "drop size", min: 0, max: 1, step: 0.01, def: 0.5, group: "src", fmt: fmtFixed(2) },
    { key: "ripple_speed", label: "ripple speed", min: 0.1, max: 3, step: 0.05, def: 1, group: "src", fmt: fmtFixed(2) },
    { key: "decay", label: "decay", min: 0, max: 1, step: 0.01, def: 0.7, group: "src", fmt: fmtFixed(2) },
    { key: "distort", label: "distort", min: 0, max: 1, step: 0.01, def: 0.6, group: "src", fmt: fmtFixed(2) },
    { key: "shine", label: "shine", min: 0, max: 1, step: 0.01, def: 0.5, group: "src", fmt: fmtFixed(2) },
    { key: "opacity", label: "opacity", min: 0, max: 1, step: 0.01, def: 1, group: "src", fmt: fmtFixed(2) },
  ],
  "clouds": [
    { key: "coverage", label: "coverage", min: 0, max: 1, step: 0.01, def: 0.5, group: "src", fmt: fmtFixed(2) },
    { key: "scale", label: "scale", min: 0, max: 1, step: 0.01, def: 0.5, group: "src", fmt: fmtFixed(2) },
    { key: "softness", label: "softness", min: 0, max: 1, step: 0.01, def: 0.5, group: "src", fmt: fmtFixed(2) },
    { key: "drift", label: "drift", min: 0, max: 2, step: 0.05, def: 0.5, group: "src", fmt: fmtFixed(2) },
    { key: "direction", label: "direction", min: 0, max: 360, step: 1, def: 15, group: "src", fmt: fmtDeg },
    { key: "turbulence", label: "turbulence", min: 0, max: 1, step: 0.01, def: 0.5, group: "src", fmt: fmtFixed(2) },
    { key: "light_angle", label: "light angle", min: 0, max: 360, step: 1, def: 300, group: "src", fmt: fmtDeg },
    { key: "shading", label: "shading", min: 0, max: 1, step: 0.01, def: 0.6, group: "src", fmt: fmtFixed(2) },
    { key: "silver", label: "silver", min: 0, max: 1, step: 0.01, def: 0.4, group: "src", fmt: fmtFixed(2) },
    { key: "brightness", label: "brightness", min: 0, max: 1, step: 0.01, def: 0.65, group: "src", fmt: fmtFixed(2) },
    { key: "opacity", label: "opacity", min: 0, max: 1, step: 0.01, def: 1, group: "src", fmt: fmtFixed(2) },
  ],
};
