// Node factories (01 §3.1) + the persisted graph schema version. Each factory
// seeds a card's default `data` (the same defaults normalizeGraph coerces old
// saves toward).

import { FLUID_PARAMS, coercePorts, mkInputId, mkNodeId, mkSlotId } from "./core";
import type {
  AnimatePointsNode,
  BackdropNode,
  Binding,
  ColorData,
  ColorNode,
  CombineMedium,
  CombineNode,
  CombineSlot,
  FluidNode,
  GateNode,
  Graph,
  ImageNode,
  ImagegenNode,
  SlideshowNode,
  LfoNode,
  LyricsNode,
  MathNode,
  MergePointsNode,
  NoiseNode,
  OutputNode,
  PatternNode,
  PointsNode,
  ScopeNode,
  ShaperNode,
  SignalNode,
  VideoNode,
} from "../types";

// ---- node factories (01 §3.1) ------------------------------------------------

export function signalNode(
  signal: { id: string; name?: string },
  x: number,
  y: number
): SignalNode {
  return {
    id: mkNodeId(),
    type: "signal",
    x,
    y,
    data: { signalId: signal.id, label: signal.name },
  };
}

export function outputNode(x: number, y: number): OutputNode {
  return { id: mkNodeId(), type: "output", x, y, data: { title: "preview" } };
}

export function fluidNode(x: number, y: number): FluidNode {
  const ports: Record<string, { binding: Binding }> = {};
  for (const p of FLUID_PARAMS) ports[p.key] = { binding: { kind: "const", value: p.def } };
  return {
    id: mkNodeId(),
    type: "fluid",
    x,
    y,
    data: {
      // No `duration`: the clip always spans the full segment (set by the executor).
      static: {
        grid: 96,
        fps: 24,
        color: [0.27, 0.69, 1],
        intensity: 1,
        opacity: 1,
        enabled: true,
        radial: false,
        wrap: true,
        points: [[0.5, 0.5]],
        path_speed: 1,
        path_closed: false,
        path_pingpong: false,
      },
      ports,
    },
  };
}

// The current persisted graph schema version. Bump when the saved graph shape
// changes; normalizeGraph() upgrades any older save to here and re-stamps it.
//   v1: signal/fluid/output node-graph.
//   v2: + combine + points nodes, the fluid `positions` input, minimize set.
//   v3: + modulator (value) cards — math / lfo / noise / shaper.
//   v4: + points cards — pattern / animate-points / mirror-points.
//   v5: + video FX cards — transform / feedback / color / warp (ported, modulatable).
//   v6: + source cards — gradient / particles / lyrics.
//   v7: removed the gradient / particles / feedback / warp / mirror-points cards —
//       normalizeGraph now drops nodes of any unknown type (+ their edges).
//   v8: the fluid's COLOR group was extracted into a standalone `color` (dye) card
//       wired into the fluid's `color` input; the old `color` (grade FX) card is now
//       `grade`. normalizeGraph renames legacy `color`→`grade` for pre-v8 saves.
//   v9: + shaper `delay`(ms)/`wrap` fields for time-shifting a value.
//  v10: removed the transform / grade video-FX cards — normalizeGraph drops them (and
//       any pre-v8 `color`→`grade` renames) as unknown types.
//  v11: lyrics card gained font, a text box (box_x/y/w/h), and outline/outlineWidth.
//  v12: lyrics dropped `position` + the size/r/g/b ports — the box defines size/placement
//       and a wired `color` card drives the fill. normalizeGraph drops the retired ports.
//  v13: cards render COMPACT by default; the persisted set inverted from `minimized`
//       (which cards were collapsed) to `expanded` (which cards show their full body).
//       normalizeGraph inverts a pre-v13 save's `minimized` into `expanded` and strips it.
//  v14: loose edges — a wire dropped on a card may persist with the `__in`
//       sentinel targetPort (no binding) until a port is assigned. Older saves
//       can't contain the sentinel; normalizeGraph keeps loose edges as-is.
//  v15: the imagegen card split — pre-v15 `imagegen` (slideshow + generator in one)
//       becomes `slideshow`; the new `imagegen` is a pure generator (prompts list)
//       feeding a slideshow's `images` input.
export const GRAPH_VERSION = 15;

export function emptyGraph(): Graph {
  return { version: GRAPH_VERSION, nodes: [], edges: [], expanded: [], view: { tx: 0, ty: 0, scale: 1 } };
}

// ---- combine node (spec 10) --------------------------------------------------
// Composes N video inputs into one. mode "merge" = the inputs' emitters share ONE
// simulation (using THIS card's medium); "stack" = render each input and alpha-over
// them in input order (index 0 = top) with per-input opacity. Inputs are ordered
// slots; a video edge targets a slot by its id (targetPort).
export const combineSlot = (opacity = 1): CombineSlot => ({ id: mkSlotId(), opacity });
export const COMBINE_MEDIUM: CombineMedium = {
  dissipation: 0.95,
  velocity_dissipation: 0.97,
  viscosity: 0.0,
  vorticity: 6.0,
};

export function combineNode(x: number, y: number): CombineNode {
  return {
    id: mkNodeId(),
    type: "combine",
    x,
    y,
    data: { mode: "merge", inputs: [combineSlot(), combineSlot()], medium: { ...COMBINE_MEDIUM } },
  };
}

// ---- points node (spec 11) ---------------------------------------------------
// A drawn set of source positions (normalised 0..1). Wired into a fluid's
// `positions` input, the fluid emits one source per point (sharing its params).
// Output port flow is "points". Seeded with one centre point.
export function pointsNode(x: number, y: number): PointsNode {
  return { id: mkNodeId(), type: "points", x, y, data: { points: [[0.5, 0.5]] } };
}

// ---- modulator (value) cards -------------------------------------------------
// Value-domain generators/operators. Inputs (math/shaper) are plain value edges —
// no lo/hi binding, the 0..1 curve passes through. Seeded so renders stay cache-stable.
export function mathNode(x: number, y: number): MathNode {
  return {
    id: mkNodeId(),
    type: "math",
    x,
    y,
    data: { op: "multiply", inputs: [mkInputId(), mkInputId()], mix: 0.5 },
  };
}
export function lfoNode(x: number, y: number): LfoNode {
  return {
    id: mkNodeId(),
    type: "lfo",
    x,
    y,
    data: { shape: "sine", rateMode: "cycles", rate: 4, phase: 0, duty: 0.5 },
  };
}
export function noiseNode(x: number, y: number): NoiseNode {
  return { id: mkNodeId(), type: "noise", x, y, data: { rate: 1, seed: 1, octaves: 2 } };
}
export function shaperNode(x: number, y: number): ShaperNode {
  return {
    id: mkNodeId(),
    type: "shaper",
    x,
    y,
    data: {
      delay: 0,
      wrap: false,
      attack: 5,
      release: 250,
      invert: false,
      threshold: 0,
      gamma: 1,
      gain: 1,
      offset: 0,
      lo: 0,
      hi: 1,
    },
  };
}
export function gateNode(x: number, y: number): GateNode {
  return { id: mkNodeId(), type: "gate", x, y, data: { threshold: 0.5, hysteresis: 0.1, invert: false } };
}
export function scopeNode(x: number, y: number): ScopeNode {
  return { id: mkNodeId(), type: "scope", x, y, data: {} };
}

// ---- points cards ------------------------------------------------------------
// Generate / transform a `points` set. Pattern is a generator; animate takes a points
// input (plain points edges) and passes a transformed set through.
export function patternNode(x: number, y: number): PatternNode {
  return {
    id: mkNodeId(),
    type: "pattern",
    x,
    y,
    data: { layout: "circle", count: 6, radius: 0.3, rotation: 0, seed: 1, offsetX: 0, offsetY: 0 },
  };
}
export function animatePointsNode(x: number, y: number): AnimatePointsNode {
  return {
    id: mkNodeId(),
    type: "animate-points",
    x,
    y,
    data: { mode: "orbit", amount: 0.15, rate: 1, angle: 0, count: 3, fade: 1 },
  };
}
// Concatenates N points inputs into one set. Two input ports to start; reuses the
// generic addInputPort/removeInputPort helpers (data.inputs: string[]).
export function mergePointsNode(x: number, y: number): MergePointsNode {
  return {
    id: mkNodeId(),
    type: "merge-points",
    x,
    y,
    data: { inputs: [mkInputId(), mkInputId()] },
  };
}
// ---- color source card -------------------------------------------------------
// Sets the fluid's dye colour, wired into a fluid's `color` input. Modes: swatch (a
// solid colour), rgb (per-channel modulatable ports), gradient (stops + a modulatable
// `position` that samples along them). All values are ports (same binding model).
export const COLOR_STOPS_DEFAULT: ColorData["stops"] = [
  { t: 0, color: "#2a4eff" },
  { t: 1, color: "#ff5ac8" },
];
export function colorNode(x: number, y: number): ColorNode {
  return {
    id: mkNodeId(),
    type: "color",
    x,
    y,
    data: { mode: "swatch", stops: COLOR_STOPS_DEFAULT.map((s) => ({ ...s })), ports: coercePorts("color", undefined) },
  };
}

// ---- source cards (→ video) --------------------------------------------------
export function lyricsNode(x: number, y: number): LyricsNode {
  return {
    id: mkNodeId(),
    type: "lyrics",
    x,
    y,
    data: {
      font: "inter",
      align: "center",
      case: "none",
      reveal: "word",
      box_x: 0.05,
      box_y: 0.08,
      box_w: 0.9,
      box_h: 0.84,
      outline: true,
      outlineWidth: 0.12,
      ports: coercePorts("lyrics", undefined),
    },
  };
}

// Image / video layer sources: an uploaded asset placed full-frame by default, scaled to
// `fit`. assetUrl starts empty (the card's drop zone fills it via uploadAsset). Only
// `opacity` is a port; the box + fit (and video timing) are static data.
export function imageNode(x: number, y: number): ImageNode {
  return {
    id: mkNodeId(),
    type: "image",
    x,
    y,
    data: {
      assetUrl: "",
      box_x: 0,
      box_y: 0,
      box_w: 1,
      box_h: 1,
      fit: "cover",
      ports: coercePorts("image", undefined),
    },
  };
}
export function videoNode(x: number, y: number): VideoNode {
  return {
    id: mkNodeId(),
    type: "video",
    x,
    y,
    data: {
      assetUrl: "",
      box_x: 0,
      box_y: 0,
      box_w: 1,
      box_h: 1,
      fit: "cover",
      sync: "song",
      start: 0,
      loop: true,
      ports: coercePorts("video", undefined),
    },
  };
}
export function slideshowNode(x: number, y: number): SlideshowNode {
  return {
    id: mkNodeId(),
    type: "slideshow",
    x,
    y,
    data: {
      assetUrls: [],
      box_x: 0,
      box_y: 0,
      box_w: 1,
      box_h: 1,
      fit: "cover",
      threshold: 0.5,
      hysteresis: 0.1,
      ports: coercePorts("slideshow", undefined),
    },
  };
}
export function imagegenNode(x: number, y: number): ImagegenNode {
  return {
    id: mkNodeId(),
    type: "imagegen",
    x,
    y,
    data: { prompts: [""], seed: 1, assetUrls: [] },
  };
}
export function backdropNode(x: number, y: number): BackdropNode {
  return {
    id: mkNodeId(),
    type: "backdrop",
    x,
    y,
    data: { color: "#101418", ports: coercePorts("backdrop", undefined) },
  };
}
