// The fluid param spec — the shared source of truth (01 §3.5). Mirrors backend
// animation_params.PARAMS, with UI metadata (label/step/group/fmt). Ranges match
// FluidLab.jsx controls and the backend; 09 asserts the key sets are identical.

export const FLUID_PARAMS = [
  { key: "emit", label: "emit", min: 0, max: 1, step: 0.02, def: 0.30, group: "source", fmt: v => v.toFixed(2) },
  { key: "radius", label: "radius", min: 0.02, max: 0.3, step: 0.01, def: 0.08, group: "source", fmt: v => v.toFixed(2) },
  { key: "force", label: "force", min: 0, max: 60, step: 1, def: 20, group: "source" },
  { key: "angle", label: "angle", min: 0, max: 360, step: 5, def: 270, group: "source", fmt: v => `${v|0}°` },
  { key: "r", label: "red", min: 0, max: 1, step: 0.01, def: 0.27, group: "color", fmt: v => v.toFixed(2) },
  { key: "g", label: "green", min: 0, max: 1, step: 0.01, def: 0.69, group: "color", fmt: v => v.toFixed(2) },
  { key: "b", label: "blue", min: 0, max: 1, step: 0.01, def: 1.0, group: "color", fmt: v => v.toFixed(2) },
  { key: "intensity", label: "intensity", min: 0, max: 3, step: 0.1, def: 1.0, group: "color", fmt: v => v.toFixed(1) },
  { key: "opacity", label: "opacity", min: 0, max: 1, step: 0.05, def: 1.0, group: "color", fmt: v => v.toFixed(2) },
  { key: "dissipation", label: "dissip.", min: 0.85, max: 0.995, step: 0.005, def: 0.95, group: "medium", fmt: v => v.toFixed(3) },
  { key: "velocity_dissipation", label: "vel diss.", min: 0.85, max: 0.995, step: 0.005, def: 0.97, group: "medium", fmt: v => v.toFixed(3) },
  { key: "viscosity", label: "viscosity", min: 0, max: 0.5, step: 0.02, def: 0.0, group: "medium", fmt: v => v.toFixed(2) },
  { key: "vorticity", label: "vorticity", min: 0, max: 10, step: 0.5, def: 6.0, group: "medium", fmt: v => v.toFixed(1) },
];

export const FLUID_PARAM_KEYS = FLUID_PARAMS.map(p => p.key);

export const fluidParam = k => FLUID_PARAMS.find(p => p.key === k);
