// AUTO-GENERATED from backend/animation_params.py (FLUID_PARAM_SPEC).
// Do NOT edit by hand — run `python -m backend.gen_fluid_params` (or `make
// gen-params`) and commit the result. A pytest asserts this file matches the spec.
//
// The fluid param spec (01 §3.5): native-unit ranges/defaults + UI metadata
// (label/step/group/fmt). simulate() reads each key under source.* or fluid.*.

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
