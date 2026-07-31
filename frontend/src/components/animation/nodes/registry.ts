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
import MontageNode from "./MontageNode";
import PointsNode from "./PointsNode";
import MathNode from "./MathNode";
import LfoNode from "./LfoNode";
import NoiseNode from "./NoiseNode";
import ShaperNode from "./ShaperNode";
import GateNode from "./GateNode";
import ChangeNode from "./ChangeNode";
import ImagegenNode from "./ImagegenNode";
import SlideshowNode from "./SlideshowNode";
import ScopeNode from "./ScopeNode";
import PatternNode from "./PatternNode";
import AnimatePointsNode from "./AnimatePointsNode";
import MergePointsNode from "./MergePointsNode";
import ColorNode from "./ColorNode";
import LyricsNode from "./LyricsNode";
import TextNode from "./TextNode";
import ImageNode from "./ImageNode";
import VideoNode from "./VideoNode";
import BackdropNode from "./BackdropNode";
import WavesNode from "./WavesNode";
import LightningNode from "./LightningNode";
import FireNode from "./FireNode";
import AuroraNode from "./AuroraNode";
import RainNode from "./RainNode";
import CloudsNode from "./CloudsNode";
import TransformNode from "./TransformNode";
import StylizeNode from "./StylizeNode";
import DreamNode from "./DreamNode";
import ExtractNode from "./ExtractNode";
import EchoNode from "./EchoNode";
import ColorGradeNode from "./ColorGradeNode";
import {
  fluidNode,
  outputNode,
  combineNode,
  montageNode,
  pointsNode,
  mathNode,
  lfoNode,
  noiseNode,
  shaperNode,
  gateNode,
  changeNode,
  scopeNode,
  patternNode,
  animatePointsNode,
  mergePointsNode,
  colorNode,
  lyricsNode,
  textNode,
  imageNode,
  imagegenNode,
  slideshowNode,
  videoNode,
  backdropNode,
  wavesNode,
  lightningNode,
  fireNode,
  auroraNode,
  rainNode,
  cloudsNode,
  transformNode,
  stylizeNode,
  dreamNode,
  extractNode,
  echoNode,
  colorgradeNode,
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
// the data-flow: raw sources + value modulators + drawn points feed the generators,
// which are composited, then output.
export type PaletteCategory =
  | "sources"
  | "modulators"
  | "points"
  | "generators"
  | "montage"
  | "compositing"
  | "output";
export const PALETTE_CATEGORIES: { key: PaletteCategory; label: string }[] = [
  { key: "sources", label: "Sources" },
  { key: "modulators", label: "Modulators" },
  { key: "points", label: "Points" },
  { key: "generators", label: "Generators" },
  // Montage carries the whole recap-video workflow (the composition editor opens
  // from it) — central enough to deserve its own palette entry rather than hiding
  // among the compositing FX.
  { key: "montage", label: "Montage" },
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
      category: "points",
      help: "Draw source points by hand; wire into a fluid's positions to emit one source per point.",
      io: { out: "points" },
    },
  },
  combine: {
    type: "combine",
    Component: CombineNode,
    chrome: { title: "combine", accent: "var(--fx)", outFlow: "video" },
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
  montage: {
    type: "montage",
    Component: MontageNode,
    chrome: { title: "montage", accent: "var(--fx)", outFlow: "video" },
    factory: montageNode,
    palette: {
      label: "Montage",
      title: "Cut clips (or whole compositions) on the music's rhythm",
      order: 1,
      category: "montage",
      help: "A rhythm-driven switcher over composition EXTRACTS: pick clips (or reuse compositions), and every cut — the trigger's rising edges plus your manual breakpoints — plays the next one, re-timed to start at the cut. Click the card to open the montage editor.",
      io: { in: "trigger", out: "video" },
    },
  },
  transform: {
    type: "transform",
    Component: TransformNode,
    chrome: { title: "transform", accent: "var(--fx)", outFlow: "video" },
    factory: transformNode,
    palette: {
      label: "Transform",
      title: "Warp the video — pan/zoom/rotate, mirror, kaleidoscope",
      order: 3.5,
      category: "compositing",
      help: "Pans, zooms, rotates, mirrors or kaleidoscopes a video stream — wire rotate to a signal for beat-locked motion. Feeds an output or a layered combine (never a merge).",
      io: { in: "video", out: "video" },
    },
  },
  extract: {
    type: "extract",
    Component: ExtractNode,
    chrome: { title: "extract", accent: "var(--fx)", outFlow: "video" },
    factory: extractNode,
    palette: {
      label: "Extract",
      title: "Extract a control image (canny / soft edges) from any video for ControlNet",
      order: 3.55,
      category: "compositing",
      help: "Turns any video into a structure map (canny edges or soft-edge). Wire its output into AI Stylize's control input to guide the generation by the video's shapes.",
      io: { in: "video", out: "video" },
    },
  },
  stylize: {
    type: "stylize",
    Component: StylizeNode,
    chrome: { title: "ai stylize", accent: "var(--fx)", outFlow: "video" },
    factory: stylizeNode,
    palette: {
      label: "AI Stylize",
      title: "Restyle any video with AI — img2img toward a prompt, optional inpaint",
      order: 3.6,
      category: "compositing",
      help: "Repaints the incoming video toward a text prompt (img2img); strength is a modulatable port and inpaint confines it to the shape. Wire an Extract card into control to guide it. Generates on demand into a clip; passes the video through until then.",
      io: { in: "video", out: "video" },
    },
  },
  dream: {
    type: "dream",
    Component: DreamNode,
    chrome: { title: "dream", accent: "var(--fx)", outFlow: "video" },
    factory: dreamNode,
    palette: {
      label: "Dream",
      title: "Generate imagery that follows a control track — one image per frame",
      order: 3.7,
      category: "compositing",
      help: "Invents every frame from scratch (txt2img + ControlNet) following a wired control track — an Extract card's edges or depth. A trigger signal splits the window into parts and each part gets its own prompt, with per-prompt crossfades. Generates on demand into a clip; passes the control through until then.",
      io: { in: "video", out: "video" },
    },
  },
  echo: {
    type: "echo",
    Component: EchoNode,
    chrome: { title: "echo", accent: "var(--fx)", outFlow: "video" },
    factory: echoNode,
    palette: {
      label: "Echo",
      title: "Motion trails — movement leaves fading ghosts",
      order: 3.69,
      category: "compositing",
      help: "Motion trails: a decayed running max of the past mixed back under the frame, so movement leaves fading ghosts. Wire length to a signal for beat-pumped trails. Feeds an output or a layered combine (never a merge).",
      io: { in: "video", out: "video" },
    },
  },
  colorgrade: {
    type: "colorgrade",
    Component: ColorGradeNode,
    chrome: { title: "color grade", accent: "var(--fx)", outFlow: "video" },
    factory: colorgradeNode,
    palette: {
      label: "Color Grade",
      title: "Recolour the video — thermal, duotone, or neon edges",
      order: 3.67,
      category: "compositing",
      help: "Thermal heat-camera, duotone poster remap, or neon edge-glow. Wire a gradient color card into tint and bind its position — the grade sweeps colour with the music. Grade modes belong at the end of the chain.",
      io: { in: "video + color (tint)", out: "video" },
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
  change: {
    type: "change",
    Component: ChangeNode,
    chrome: { title: "change", accent: "var(--mod)", outFlow: "value" },
    factory: changeNode,
    palette: {
      label: "Change",
      title: "How fast a signal is changing (smoothed derivative)",
      order: 13.6,
      category: "modulators",
      help: "Any value in → its rate of CHANGE out (units/second, smoothed). Where the gate asks «is it high?», change asks «is it moving?» — feed a Gate to cut a Montage on musical transitions instead of level.",
      io: { in: "1 signal", out: "change rate" },
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
      category: "points",
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
      category: "points",
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
      category: "points",
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
  text: {
    type: "text",
    Component: TextNode,
    chrome: { title: "text", accent: "var(--courant)", outFlow: "video" },
    factory: textNode,
    palette: {
      label: "Text",
      title: "A free-typed caption placed in the frame, like an Instagram sticker",
      order: 43,
      category: "generators",
      help: "Type any text and place it in a box — same font/outline/size controls as the lyrics card, but the words are yours and always on. Wire a color card into fill/outline to recolour it; opacity is modulatable. Combine it over anything.",
      io: { in: "color cards (fill/outline) + a signal on opacity", out: "video" },
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
      category: "generators",
      help: "Uploads an image and places it into a box (cover/contain/stretch) as a video layer. Feed it to a stack combine or an output; opacity is a modulatable port.",
      io: { in: "a signal on opacity", out: "video" },
    },
  },
  slideshow: {
    type: "slideshow",
    Component: SlideshowNode,
    chrome: { title: "slideshow", accent: "var(--courant)", outFlow: "video" },
    factory: slideshowNode,
    palette: {
      label: "Slideshow",
      title: "A set of stills advanced by a trigger signal",
      order: 33.4,
      category: "generators",
      help: "Hold several images (uploads, the library, or a wired Image gen card) and switch to the NEXT one each time the trigger rises past the threshold. The card shows how many switches this segment will make.",
      io: { in: "trigger + images", out: "video" },
    },
  },
  imagegen: {
    type: "imagegen",
    Component: ImagegenNode,
    chrome: { title: "image gen", accent: "var(--courant)", outFlow: "images" },
    factory: imagegenNode,
    palette: {
      label: "Image gen",
      title: "Generate images locally — one per prompt",
      order: 33.5,
      category: "generators",
      help: "Write one prompt per image and \u2728 generate them locally (seeded, reproducible). Wire the images output into a Slideshow card to show them.",
      io: { in: "\u2014", out: "images" },
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
      category: "generators",
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
      category: "generators",
      help: "Fills the whole frame with a solid colour as a video layer. Wire it into the BOTTOM input of a stack combine for a non-black background; opacity is a modulatable port.",
      io: { in: "a signal on opacity", out: "video" },
    },
  },
  waves: {
    type: "waves",
    Component: WavesNode,
    chrome: { title: "waves", accent: "var(--courant)", outFlow: "video" },
    factory: wavesNode,
    palette: {
      label: "Waves",
      title: "Pool water: caustics + refraction of an optional video input",
      order: 34,
      category: "generators",
      help: "Real pool water: a dispersion-correct wave spectrum focuses light into the dancing caustic filaments and REFRACTS whatever you wire into `video` (an image, a clip, a fluid) — chromatic fringes, sun glints and the blue-green depth tint included. Empty input renders on the palette. Merged waves cards superpose their spectra on one surface.",
      io: { in: "optional video + signals on its ports", out: "video" },
    },
  },
  lightning: {
    type: "lightning",
    Component: LightningNode,
    chrome: { title: "lightning", accent: "var(--electric, #7aa2ff)", outFlow: "video" },
    factory: lightningNode,
    palette: {
      label: "Lightning",
      title: "Real dielectric-breakdown bolts: origin, direction and restrikes",
      order: 35,
      category: "generators",
      help: "Discharges grown by the physics of real lightning (Laplacian breakdown): hierarchical self-avoiding branches from any origin toward any direction, a white-hot core in a tinted halo, dart-leader restrikes of the same channel (`flicker`) and origin-centred sky flash. Wire an onset to `strike`; a points card into `positions` strikes from a different point each time.",
      io: { in: "onset on strike, optional points", out: "video" },
    },
  },
  fire: {
    type: "fire",
    Component: FireNode,
    chrome: { title: "fire", accent: "var(--ember, #ff7a3c)", outFlow: "video" },
    factory: fireNode,
    palette: {
      label: "Fire",
      title: "Buoyant combustion on the fluid solver — place, aim and merge flames",
      order: 36,
      category: "generators",
      help: "A real flame: heat rises through the fluid solver, cools quartically and glows with blackbody colour. Place it with origin x/y, aim it with `direction` (a sideways torch works), size it with `width`/`cooling`. A points card lights one flame per point, and close flames lean together and MERGE — as do fire cards merged in a combine, even with fluids.",
      io: { in: "signals on its ports + optional points", out: "video" },
    },
  },
  aurora: {
    type: "aurora",
    Component: AuroraNode,
    chrome: { title: "aurora", accent: "var(--aurora, #4fe0a0)", outFlow: "video" },
    factory: auroraNode,
    palette: {
      label: "Aurora",
      title: "Calm northern-light curtains: horizontal arcs, vertical rays",
      order: 37,
      category: "generators",
      help: "Built like the real thing: near-horizontal arcs with a sharp lower edge, vertical rays whose intensities breathe on the ~1 s oxygen-glow timescale, colours stratified by altitude (purple fringe, green body, red top). Quasi-static and veil-calm by default; `position y`/`height` place it in the sky. Wire harmonic to `brightness`.",
      io: { in: "signals on brightness / sway / shimmer", out: "video" },
    },
  },
  rain: {
    type: "rain",
    Component: RainNode,
    chrome: { title: "rain", accent: "var(--courant)", outFlow: "video" },
    factory: rainNode,
    palette: {
      label: "Rain",
      title: "Drops on a liquid surface — real interfering rings refract the input",
      order: 38,
      category: "generators",
      help: "The input layer becomes the floor of a liquid: each drop punches a crater, rebounds and rings out — real wave-equation rings that collide and interfere, bending the image as they cross. A points card turns uniform rain into fixed drip points; merged rain cards drip into ONE shared surface. Wire energy to `density` and it pours with the music.",
      io: { in: "optional video + points + signals", out: "video" },
    },
  },
  clouds: {
    type: "clouds",
    Component: CloudsNode,
    chrome: { title: "clouds", accent: "var(--nebula, #a06fe0)", outFlow: "video" },
    factory: cloudsNode,
    palette: {
      label: "Clouds",
      title: "Sunlit cumulus: self-shadowed masses with a silver lining",
      order: 39,
      category: "generators",
      help: "Real-looking clouds: billowing masses that self-shadow along `light angle` (a short Beer-Lambert march toward the sun), brighter in the crevices than on the bulges like true cumulus, with a silver lining flaring on thin rims near the sun. Sky shows through between them. Merged clouds cards shade under ONE sun. A dreamy sky or a nebula by palette.",
      io: { in: "signals on coverage / drift / light", out: "video" },
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
