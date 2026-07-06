// THE node-type registry: one entry per node type is the single source of truth for
// how it's created, rendered, themed, and added from the palette. Adding a node type
// = add a Component + one entry here (+ a backend handler) — no edits to Palette,
// renderAnimNode, or CompactCard.
//
// Import direction (no cycles): registry -> node components + graphModel factories.
// Consumers (Palette / renderAnimNode / CompactCard / NodeSettingsModal) import the
// registry; the node components and graphModel must NOT import it. (CompactCard lives
// in nodes/ but is a consumer, not a registered card — it may import the registry.)

import type { ComponentType } from "react";
import SignalNode from "./SignalNode";
import FluidNode from "./FluidNode";
import OutputNode from "./OutputNode";
import CombineNode from "./CombineNode";
import PointsNode from "./PointsNode";
import MathNode from "./MathNode";
import LfoNode from "./LfoNode";
import NoiseNode from "./NoiseNode";
import ShaperNode from "./ShaperNode";
import GateNode from "./GateNode";
import ImagegenNode from "./ImagegenNode";
import ScopeNode from "./ScopeNode";
import PatternNode from "./PatternNode";
import AnimatePointsNode from "./AnimatePointsNode";
import MergePointsNode from "./MergePointsNode";
import ColorNode from "./ColorNode";
import LyricsNode from "./LyricsNode";
import ImageNode from "./ImageNode";
import VideoNode from "./VideoNode";
import BackdropNode from "./BackdropNode";
import {
  fluidNode,
  outputNode,
  combineNode,
  pointsNode,
  mathNode,
  lfoNode,
  noiseNode,
  shaperNode,
  gateNode,
  scopeNode,
  patternNode,
  animatePointsNode,
  mergePointsNode,
  colorNode,
  lyricsNode,
  imageNode,
  imagegenNode,
  videoNode,
  backdropNode,
} from "../../../lib/graphModel";
import type { GraphNode, NodeType, PortFlow } from "../../../lib/types";
import type { NodeProps } from "./nodeProps";

export type { NodeProps }; // re-export so existing importers keep working

export interface NodeChrome {
  title: string;
  accent: string; // CSS colour; signal overrides with its stem colour
  outFlow: PortFlow; // the flow of the node's single `out` port
}

// The add-node menu is grouped by these categories, in this display order, following
// the data-flow: sources feed generators, which are composited, then output.
export type PaletteCategory =
  | "sources"
  | "modulators"
  | "generators"
  | "compositing"
  | "output";
export const PALETTE_CATEGORIES: { key: PaletteCategory; label: string }[] = [
  { key: "sources", label: "Sources" },
  { key: "modulators", label: "Modulators" },
  { key: "generators", label: "Generators" },
  { key: "compositing", label: "Compositing" },
  { key: "output", label: "Output" },
];

export interface NodeSpec {
  type: NodeType;
  // The card component — now that every card is .tsx and implements NodeProps, a card
  // whose props don't match is a compile error.
  Component: ComponentType<NodeProps>;
  chrome: NodeChrome;
  // Generic palette factory (x, y) -> node. Omitted for `signal`, which is added via
  // the signal picker (the menu entry opens it) rather than a plain factory.
  factory?: (x: number, y: number) => GraphNode;
  // Menu entry: `order` is the global add-order (kept ascending so paletteSpecs stays
  // sorted); `category` places it in the grouped dropdown. `help` (what it does + how)
  // and `io` (input → output flows) feed the hover tooltip in the add menu.
  palette?: {
    label: string;
    title?: string;
    order: number;
    category: PaletteCategory;
    help?: string;
    io?: { in?: string; out: string };
  };
}

export const NODE_TYPES: Record<NodeType, NodeSpec> = {
  signal: {
    type: "signal",
    Component: SignalNode,
    chrome: { title: "signal", accent: "var(--muted)", outFlow: "value" },
    // No factory: the menu entry opens the segment-signal picker instead.
    palette: {
      label: "Signal",
      title: "Add a signal from this segment",
      order: 0,
      category: "sources",
      help: "Exposes one of this segment's signals (from the other tab) as a 0–1 curve to drive other cards.",
      io: { out: "signal" },
    },
  },
  fluid: {
    type: "fluid",
    Component: FluidNode,
    chrome: { title: "fluid", accent: "var(--petale)", outFlow: "video" },
    factory: fluidNode,
    palette: {
      label: "Fluid",
      order: 1,
      category: "generators",
      help: "The fluid simulation — every parameter (force, vorticity, emit, colour…) is a port you can drive with a signal.",
      io: { in: "points + signals on its params", out: "video" },
    },
  },
  points: {
    type: "points",
    Component: PointsNode,
    chrome: { title: "points", accent: "var(--courant)", outFlow: "points" },
    factory: pointsNode,
    palette: {
      label: "Points",
      title: "Draw source points to feed a fluid's positions",
      order: 2,
      category: "sources",
      help: "Draw source points by hand; wire into a fluid's positions to emit one source per point.",
      io: { out: "points" },
    },
  },
  combine: {
    type: "combine",
    Component: CombineNode,
    chrome: { title: "combine", accent: "#c0902e", outFlow: "video" },
    factory: combineNode,
    palette: {
      label: "Combine",
      title: "Combine fluids — merge (interact) or layered (stack)",
      order: 3,
      category: "compositing",
      help: "Composes several video streams: merge = their sources share one sim and interact; layered = stacked with per-input opacity.",
      io: { in: "2+ video", out: "video" },
    },
  },
  output: {
    type: "output",
    Component: OutputNode,
    chrome: { title: "output", accent: "var(--text)", outFlow: "video" },
    factory: outputNode,
    palette: {
      label: "Output",
      order: 4,
      category: "output",
      help: "The render sink — shows the looping clip. Each output renders its own pipeline; it also passes its input through.",
      io: { in: "video", out: "video" },
    },
  },
  math: {
    type: "math",
    Component: MathNode,
    chrome: { title: "math", accent: "var(--mod)", outFlow: "value" },
    factory: mathNode,
    palette: {
      label: "Math",
      title: "Blend signals — multiply, add, max/min, or crossfade",
      order: 10,
      category: "modulators",
      help: "Combines two or more signals: multiply to gate, max to floor, add/subtract, or mix to crossfade.",
      io: { in: "2+ signals", out: "signal" },
    },
  },
  lfo: {
    type: "lfo",
    Component: LfoNode,
    chrome: { title: "lfo", accent: "var(--mod)", outFlow: "value" },
    factory: lfoNode,
    palette: {
      label: "LFO",
      title: "Generate motion with no audio — a sine/saw oscillator",
      order: 11,
      category: "modulators",
      help: "A sine/triangle/saw/square oscillator (no audio needed) at a rate in cycles-per-clip or Hz. Steady drift or pulsing.",
      io: { out: "signal" },
    },
  },
  noise: {
    type: "noise",
    Component: NoiseNode,
    chrome: { title: "noise", accent: "var(--mod)", outFlow: "value" },
    factory: noiseNode,
    palette: {
      label: "Noise",
      title: "Organic random drift (seeded, so it renders the same)",
      order: 12,
      category: "modulators",
      help: "Smooth fractal random wander where an LFO would feel mechanical. Seeded, so a given seed always renders the same.",
      io: { out: "signal" },
    },
  },
  shaper: {
    type: "shaper",
    Component: ShaperNode,
    chrome: { title: "shaper", accent: "var(--mod)", outFlow: "value" },
    factory: shaperNode,
    palette: {
      label: "Shaper",
      title: "Re-shape one signal — sharpen, soften, invert, remap",
      order: 13,
      category: "modulators",
      help: "Re-curves one signal (attack/release, gamma, threshold, invert, range remap) per use, without editing the studio.",
      io: { in: "1 signal", out: "signal" },
    },
  },
  gate: {
    type: "gate",
    Component: GateNode,
    chrome: { title: "gate", accent: "var(--mod)", outFlow: "value" },
    factory: gateNode,
    palette: {
      label: "Gate",
      title: "Turn a signal into a clean 0/1 switch (hysteresis threshold)",
      order: 13.5,
      category: "modulators",
      help: "Any value in \u2192 a clean 0/1 square out. Arms above the threshold, releases below it minus the hysteresis band, so a hovering signal can't flicker. Drives triggers and on/off ports.",
      io: { in: "1 signal", out: "0/1 signal" },
    },
  },
  scope: {
    type: "scope",
    Component: ScopeNode,
    chrome: { title: "scope", accent: "var(--mod)", outFlow: "value" },
    factory: scopeNode,
    palette: {
      label: "Scope",
      title: "Watch a value on a live sparkline + pulse pad",
      order: 14,
      category: "modulators",
      help: "Watch a value (lfo / signal / noise / math…) on a live sparkline + pulse pad; passes the same signal through unchanged.",
      io: { in: "a signal", out: "signal (passthrough)" },
    },
  },
  pattern: {
    type: "pattern",
    Component: PatternNode,
    chrome: { title: "pattern", accent: "var(--courant)", outFlow: "points" },
    factory: patternNode,
    palette: {
      label: "Pattern",
      title: "Parametric source layout — circle, grid, spiral…",
      order: 20,
      category: "sources",
      help: "Generates a parametric layout of source points (circle, ring, grid, line, spiral, scatter) instead of placing by hand.",
      io: { out: "points" },
    },
  },
  "animate-points": {
    type: "animate-points",
    Component: AnimatePointsNode,
    chrome: { title: "animate", accent: "var(--courant)", outFlow: "points" },
    factory: animatePointsNode,
    palette: {
      label: "Animate points",
      title: "Move source points over the clip — orbit, drift or chase",
      order: 21,
      category: "sources",
      help: "Moves an incoming points set over the clip: orbit circles the centre, drift slides along a heading and loops, chase keeps the points fixed and cycles which ones are lit.",
      io: { in: "points", out: "points" },
    },
  },
  "merge-points": {
    type: "merge-points",
    Component: MergePointsNode,
    chrome: { title: "merge points", accent: "var(--courant)", outFlow: "points" },
    factory: mergePointsNode,
    palette: {
      label: "Merge points",
      title: "Concatenate two or more points sets into one",
      order: 22,
      category: "sources",
      help: "Combines several points sets (Pattern / Points / Animate) into a single set — wire each into an input, output to a fluid's positions. Add inputs with + input.",
      io: { in: "points ×N", out: "points" },
    },
  },
  color: {
    type: "color",
    Component: ColorNode,
    chrome: { title: "color", accent: "var(--petale)", outFlow: "color" },
    factory: colorNode,
    palette: {
      label: "Color",
      title: "The fluid's colour — swatch, RGB channels, or a gradient you scrub",
      order: 5,
      category: "sources",
      help: "Sets the fluid's colour. Modes: swatch (one colour), rgb (drive r/g/b with signals), gradient (colour stops + a modulatable position that sweeps along them). Wire into a fluid's color input.",
      io: { in: "signals on rgb / intensity / opacity / position", out: "color" },
    },
  },
  lyrics: {
    type: "lyrics",
    Component: LyricsNode,
    chrome: { title: "lyrics", accent: "var(--courant)", outFlow: "video" },
    factory: lyricsNode,
    palette: {
      label: "Lyrics",
      title: "Burn the segment's aligned lyrics into the video, timed to the vocal",
      order: 42,
      category: "generators",
      help: "Burns this track's aligned lyrics into the frame, timed to the vocal (line or word reveal). Wire a color card into fill/outline to recolour them. Needs lyrics on the track.",
      io: { in: "color cards (fill/outline) + signals on its params", out: "video" },
    },
  },
  image: {
    type: "image",
    Component: ImageNode,
    chrome: { title: "image", accent: "var(--courant)", outFlow: "video" },
    factory: imageNode,
    palette: {
      label: "Image",
      title: "Place an uploaded image into the frame as a video layer",
      order: 30,
      category: "sources",
      help: "Uploads an image and places it into a box (cover/contain/stretch) as a video layer. Feed it to a stack combine or an output; opacity is a modulatable port.",
      io: { in: "a signal on opacity", out: "video" },
    },
  },
  imagegen: {
    type: "imagegen",
    Component: ImagegenNode,
    chrome: { title: "image gen", accent: "var(--courant)", outFlow: "video" },
    factory: imagegenNode,
    palette: {
      label: "Image gen",
      title: "A slideshow of stills advanced by a trigger signal",
      order: 33.5,
      category: "sources",
      help: "Hold several images (uploads, the library, or \u2728 generated) and switch to the NEXT one every time the trigger signal rises past the threshold \u2014 photos that change on the beat.",
      io: { in: "trigger signal", out: "video" },
    },
  },
  video: {
    type: "video",
    Component: VideoNode,
    chrome: { title: "video", accent: "var(--courant)", outFlow: "video" },
    factory: videoNode,
    palette: {
      label: "Video",
      title: "Place an uploaded video clip into the frame as a video layer",
      order: 31,
      category: "sources",
      help: "Uploads a video clip and places it into a box (cover/contain/stretch), clocked to the song or this segment with start/speed/loop. Feed it to a stack combine or an output; opacity is a modulatable port.",
      io: { in: "a signal on opacity", out: "video" },
    },
  },
  backdrop: {
    type: "backdrop",
    Component: BackdropNode,
    chrome: { title: "backdrop", accent: "var(--courant)", outFlow: "video" },
    factory: backdropNode,
    palette: {
      label: "Backdrop",
      title: "Fill the frame with a solid colour as a video layer",
      order: 29,
      category: "sources",
      help: "Fills the whole frame with a solid colour as a video layer. Wire it into the BOTTOM input of a stack combine for a non-black background; opacity is a modulatable port.",
      io: { in: "a signal on opacity", out: "video" },
    },
  },
};

// The palette-addable specs (have a generic factory + button), in button order.
export const paletteSpecs = (): NodeSpec[] =>
  Object.values(NODE_TYPES)
    .filter((s) => s.palette && s.factory)
    .sort((a, b) => a.palette!.order - b.palette!.order);

// All add-menu entries grouped by category in display order; within a category,
// entries are sorted by `order`. Includes `signal` (no factory — opens the picker).
// Empty categories are dropped so the menu only shows groups that have entries.
export interface PaletteGroup {
  category: PaletteCategory;
  label: string;
  specs: NodeSpec[];
}
export const paletteMenu = (): PaletteGroup[] =>
  PALETTE_CATEGORIES.map(({ key, label }) => ({
    category: key,
    label,
    specs: Object.values(NODE_TYPES)
      .filter((s) => s.palette?.category === key)
      .sort((a, b) => a.palette!.order - b.palette!.order),
  })).filter((g) => g.specs.length > 0);

// Header chrome for a node type, with a safe fallback for unknown types.
export const chromeFor = (type: string): NodeChrome =>
  NODE_TYPES[type as NodeType]?.chrome || { title: type, accent: "var(--muted)", outFlow: "value" };
