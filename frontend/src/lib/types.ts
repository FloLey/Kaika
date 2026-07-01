// Core domain types for the animation graph + render settings — the typed
// counterpart to the runtime shapes in lib/graph/* and output.ts. Node `data` is a
// discriminated union keyed on `type`, so `node.data.*` access is checked once the
// node's type is narrowed (e.g. `if (node.type === "fluid") node.data.ports`).

export type Quality = "draft" | "normal" | "high";

// A normalized [x, y] coordinate (0..1) on a pad — source-path points, etc.
export type Point = [number, number];

export interface OutputSettings {
  width: number;
  height: number;
  quality: Quality;
  fps: number;
  background: string;
}

// ---- studio domain: stems, signals, segments ---------------------------------
// One separated stem's served URLs + sample rate (top of its spectrogram = sr/2).
export interface StemInfo {
  sr?: number;
  spectrogram?: string;
  audio?: string;
}

// A signal: a stem + frequency band + shaping -> a drawable 0..1 curve. The
// canonical shape shared by the studio (SignalCard) and the animation layer (the
// loose `SignalDef` is now an alias of this).
export interface Signal {
  id: string;
  stemKey: string;
  minHz: number;
  maxHz: number;
  feature: string;
  name?: string;
  attack: number;
  release: number;
  invert: boolean;
  gamma: number;
  gain: number;
  offset: number;
  threshold: number;
}

// A contiguous time range [start, end] owning a list of signals and (optionally)
// an animation graph. `graph` is null when no animation has been built yet.
export interface Segment {
  id: string;
  label: string;
  start: number;
  end: number;
  signals: Signal[];
  graph?: Graph | null;
}

// ---- value-source binding ----------------------------------------------------
// A fluid param port is a constant value, or a value-source node whose 0..1 curve
// maps into [lo, hi] (native units).
export type Binding =
  | { kind: "const"; value: number }
  | { kind: "node"; nodeId: string; lo: number; hi: number };

// ---- per-node data shapes ----------------------------------------------------
export interface SignalData {
  signalId: string;
  label?: string;
}

export interface FluidStatic {
  grid: number;
  fps: number;
  color: [number, number, number];
  intensity: number;
  opacity: number;
  enabled: boolean;
  radial: boolean;
  wrap: boolean;
  points: [number, number][];
  path_speed: number;
  path_closed: boolean;
  path_pingpong: boolean;
}
export interface FluidPort {
  binding: Binding;
}
export interface FluidData {
  static: FluidStatic;
  ports: Record<string, FluidPort>;
}

export interface CombineSlot {
  id: string;
  opacity: number;
}
export interface CombineMedium {
  dissipation: number;
  velocity_dissipation: number;
  viscosity: number;
  vorticity: number;
}
export interface CombineData {
  mode: "merge" | "stack";
  inputs: CombineSlot[];
  medium: CombineMedium;
}

export interface PointsData {
  points: [number, number][];
}

export interface OutputData {
  title: string;
}

// ---- modulator (value) cards -------------------------------------------------
// Pure value-domain cards: they consume/produce a 0..1 curve, wired with plain
// value edges (no lo/hi binding — that mapping lives only at a fluid param port).
export type MathOp = "add" | "multiply" | "max" | "min" | "subtract" | "mix";
export interface MathData {
  op: MathOp;
  inputs: string[]; // ordered input-port ids (an edge targets one by id)
  mix: number; // crossfade amount for op "mix" (0 = first input, 1 = second)
}

export type LfoShape = "sine" | "triangle" | "saw" | "square";
export interface LfoData {
  shape: LfoShape;
  rateMode: "hz" | "cycles"; // hz = cycles/second; cycles = oscillations per clip
  rate: number;
  phase: number; // 0..1 of a cycle
  duty: number; // square only, 0..1
}

export interface NoiseData {
  rate: number; // change speed (control points per second)
  seed: number; // deterministic so renders are cache-stable
  octaves: number; // fractal detail (1..4)
}

export interface ShaperData {
  delay: number; // time-shift the input later, in ms
  wrap: boolean; // wrap the tail to the head instead of zero-padding
  attack: number;
  release: number;
  invert: boolean;
  threshold: number;
  gamma: number;
  gain: number;
  offset: number;
  lo: number; // output remap floor
  hi: number; // output remap ceiling
}

// A pure monitor: shows its input value (sparkline + pulse pad) and passes it through.
export interface ScopeData {
  label?: string;
}

// ---- points cards ------------------------------------------------------------
export type PatternLayout = "circle" | "ring" | "grid" | "line" | "spiral" | "scatter";
export interface PatternData {
  layout: PatternLayout;
  count: number;
  radius: number; // 0..1 (ring/circle/spiral radius, grid/line extent)
  rotation: number; // degrees
  seed: number; // scatter only
  offsetX: number; // -0.5..0.5 shift of the layout centre from frame centre
  offsetY: number; // -0.5..0.5 shift of the layout centre from frame centre
}

export type AnimatePointsMode = "orbit" | "drift" | "chase";
export interface AnimatePointsData {
  mode: AnimatePointsMode;
  amount: number; // 0..1 orbit radius / drift distance
  rate: number; // path traversals (orbit/drift) or chase cycles over the clip
  angle: number; // drift direction, degrees
  count: number; // chase: snake length (points lit at once)
  fade: number; // chase: tail taper, 0 = solid arc .. 1 = fade head→tail (snake)
}

// Concatenates N points inputs into one set. Inputs are ordered input-port ids (a
// points edge targets one by id), same model as the Math card. No other settings.
export interface MergePointsData {
  inputs: string[];
}

// The colour source card — sets the fluid's dye colour. Three modes:
//   swatch   — one solid colour (a picker writes the r/g/b const ports)
//   rgb      — r/g/b as individual modulatable ports (wire a signal per channel)
//   gradient — colour stops + a modulatable `position` (0..1) that samples along them
// Ports: r,g,b,intensity,opacity,position. Wired into a fluid's `color` input; unwired,
// the fluid uses its static colour.
export type ColorMode = "swatch" | "rgb" | "gradient";
export interface ColorStop {
  t: number; // 0..1 position along the gradient
  color: string; // hex
}
export interface ColorData {
  mode: ColorMode;
  stops: ColorStop[];
  ports: Record<string, FluidPort>;
}

// ---- source cards (→ video) --------------------------------------------------
export type LyricsPosition = "top" | "center" | "bottom";
export type LyricsAlign = "left" | "center" | "right";
export type LyricsCase = "none" | "upper" | "lower";
export type LyricsReveal = "line" | "word";
export interface LyricsData {
  position: LyricsPosition;
  align: LyricsAlign;
  case: LyricsCase;
  reveal: LyricsReveal;
  ports: Record<string, FluidPort>;
}

// ---- the discriminated node union --------------------------------------------
interface NodeBase {
  id: string;
  x: number;
  y: number;
}
export interface SignalNode extends NodeBase {
  type: "signal";
  data: SignalData;
}
export interface FluidNode extends NodeBase {
  type: "fluid";
  data: FluidData;
}
export interface CombineNode extends NodeBase {
  type: "combine";
  data: CombineData;
}
export interface PointsNode extends NodeBase {
  type: "points";
  data: PointsData;
}
export interface OutputNode extends NodeBase {
  type: "output";
  data: OutputData;
}
export interface MathNode extends NodeBase {
  type: "math";
  data: MathData;
}
export interface LfoNode extends NodeBase {
  type: "lfo";
  data: LfoData;
}
export interface NoiseNode extends NodeBase {
  type: "noise";
  data: NoiseData;
}
export interface ShaperNode extends NodeBase {
  type: "shaper";
  data: ShaperData;
}
export interface ScopeNode extends NodeBase {
  type: "scope";
  data: ScopeData;
}
export interface PatternNode extends NodeBase {
  type: "pattern";
  data: PatternData;
}
export interface AnimatePointsNode extends NodeBase {
  type: "animate-points";
  data: AnimatePointsData;
}
export interface MergePointsNode extends NodeBase {
  type: "merge-points";
  data: MergePointsData;
}
export interface ColorNode extends NodeBase {
  type: "color";
  data: ColorData;
}
export interface LyricsNode extends NodeBase {
  type: "lyrics";
  data: LyricsData;
}

export type GraphNode =
  | SignalNode
  | FluidNode
  | CombineNode
  | PointsNode
  | OutputNode
  | MathNode
  | LfoNode
  | NoiseNode
  | ShaperNode
  | ScopeNode
  | PatternNode
  | AnimatePointsNode
  | MergePointsNode
  | ColorNode
  | LyricsNode;

export type NodeType = GraphNode["type"];

// One node's `data` for a given type (e.g. NodeData<"fluid"> = FluidData).
export type NodeOf<T extends NodeType> = Extract<GraphNode, { type: T }>;

export type PortFlow = "value" | "video" | "points" | "color";

export interface GraphEdge {
  id: string;
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
}

export interface Graph {
  version: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  view?: { tx: number; ty: number; scale: number };
  minimized?: string[];
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

// One modulatable param spec entry. The fluid set is generated into fluidParams.js
// from the backend; other cards (FX / sources) declare their own in lib/nodeParams.ts.
// `group` is "source"/"color"/"medium" for fluid (drives its grouped UI); other cards
// use a free-form tag (e.g. "fx").
export interface FluidParam {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  def: number;
  group: string;
  fmt?: (v: number) => string;
}
