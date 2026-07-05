// The modulatable-param registry: per node type, the list of ports that can be a
// const value or a signal-driven [lo, hi]. The fluid set comes from the generated
// fluidParams.js; the FX / source cards declare theirs here. This is the single place
// the wiring (graphModel connect/disconnect) and the port UI (ParamRow) look up a
// param's range/default/label — so a card's ports stay in lockstep everywhere.
//
// Keep these in sync with the backend per-card specs in backend/graph.py (the values
// must match for the render to map the same [lo, hi]).

import { FLUID_PARAMS } from "./fluidParams.js";
import type { FluidParam } from "./types";

const dp = (n: number) => (v: number) => v.toFixed(n);

// The colour card's ports. r/g/b: a swatch (swatch mode) or individual modulatable
// rows (rgb mode); intensity/opacity always modulatable; position (0..1) scrubs the
// gradient in gradient mode. Mirrors backend animation_params.COLOR_PARAM_SPEC.
export const COLOR_PARAMS: FluidParam[] = [
  { key: "r", label: "red", min: 0, max: 1, step: 0.01, def: 0.27, group: "color", fmt: dp(2) },
  { key: "g", label: "green", min: 0, max: 1, step: 0.01, def: 0.69, group: "color", fmt: dp(2) },
  { key: "b", label: "blue", min: 0, max: 1, step: 0.01, def: 1, group: "color", fmt: dp(2) },
  { key: "intensity", label: "intensity", min: 0, max: 3, step: 0.1, def: 1, group: "color", fmt: dp(1) },
  { key: "opacity", label: "opacity", min: 0, max: 1, step: 0.05, def: 1, group: "color", fmt: dp(2) },
  { key: "position", label: "position", min: 0, max: 1, step: 0.01, def: 0, group: "color", fmt: dp(2) },
];

// The lyrics fill/outline colours come from wired `color` cards, and the box defines the
// text size + placement — so `opacity` is the only remaining modulatable port.
export const LYRICS_PARAMS: FluidParam[] = [
  { key: "opacity", label: "opacity", min: 0, max: 1, step: 0.01, def: 1, group: "src", fmt: dp(2) },
];

// The image / video layer sources: the box + fit (and video timing) are static data, so
// `opacity` is the only modulatable port. Mirrors backend animation_params SOURCE_PARAMS.
export const IMAGE_PARAMS: FluidParam[] = [
  { key: "opacity", label: "opacity", min: 0, max: 1, step: 0.01, def: 1, group: "src", fmt: dp(2) },
];
// `speed` is a modulatable port (the source advances by speed/fps each frame, so a wired
// signal time-warps the clip); `start`/`sync`/`loop`/box stay static. Range mirrors
// backend sources.SOURCE_PARAMS["video"]["speed"] = (0, 4, 1).
export const VIDEO_PARAMS: FluidParam[] = [
  { key: "opacity", label: "opacity", min: 0, max: 1, step: 0.01, def: 1, group: "src", fmt: dp(2) },
  { key: "speed", label: "speed", min: 0, max: 4, step: 0.05, def: 1, group: "src", fmt: dp(2) },
];
// The backdrop (solid-colour fill) source: the colour is a static swatch, so `opacity` is
// the only modulatable port. Mirrors backend sources.SOURCE_PARAMS["backdrop"].
export const BACKDROP_PARAMS: FluidParam[] = [
  { key: "opacity", label: "opacity", min: 0, max: 1, step: 0.01, def: 1, group: "src", fmt: dp(2) },
];

// node type -> its modulatable param specs. Cards with no entry have no ports.
export const NODE_PARAMS: Record<string, FluidParam[]> = {
  fluid: FLUID_PARAMS as FluidParam[],
  color: COLOR_PARAMS,
  lyrics: LYRICS_PARAMS,
  image: IMAGE_PARAMS,
  video: VIDEO_PARAMS,
  backdrop: BACKDROP_PARAMS,
};

export const nodeParams = (type: string): FluidParam[] => NODE_PARAMS[type] || [];
export const nodeParam = (type: string, key: string): FluidParam | undefined =>
  nodeParams(type).find((p) => p.key === key);
export const hasParams = (type: string): boolean => (NODE_PARAMS[type]?.length ?? 0) > 0;
