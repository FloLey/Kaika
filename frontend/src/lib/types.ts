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
// `finalOutputId` is the id of the output node marked "final" for this segment —
// the one the Final export stage renders (undefined until the user marks one).
export interface Segment {
  id: string;
  label: string;
  start: number;
  end: number;
  signals: Signal[];
  graph?: Graph | null;
  finalOutputId?: string;
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
  layer?: number; // cross-segment continuity key (final export carries a layer's sim forward)
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
  layer?: number; // cross-segment continuity key (final export carries a layer's sim forward)
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

// Hysteresis threshold: turns any 0..1 value into a clean 0/1 square — arms above
// threshold + hysteresis/2, releases below threshold - hysteresis/2 (no flicker).
export interface GateData {
  threshold: number; // the level the gate switches around
  hysteresis: number; // dead band width centred on the threshold
  invert: boolean; // flip the output (1 while BELOW the threshold)
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
// The text box defines placement + size; `align` justifies horizontally within it.
export type LyricsAlign = "left" | "center" | "right";
export type LyricsCase = "none" | "upper" | "lower";
export type LyricsReveal = "line" | "word";
export interface LyricsData {
  font: string; // key of a bundled font (GET /fonts); see backend/fonts.py
  align: LyricsAlign;
  case: LyricsCase;
  reveal: LyricsReveal;
  box_x: number; // text box, fractions 0..1 of the frame
  box_y: number;
  box_w: number;
  box_h: number;
  outline: boolean; // black outline under the fill (readable over anything)
  outlineWidth: number; // outline thickness as a fraction of the font size
  ports: Record<string, FluidPort>;
}

// Image / video layer sources (→ video). An uploaded asset (assetUrl) placed into a
// normalized box, scaled to `fit`. `opacity` is the only modulatable port; the box + fit
// (and, for video, the timing fields) are static data. Mirrors backend SOURCE_PARAMS.
export type LayerFit = "cover" | "contain" | "stretch";
export interface ImageData {
  assetUrl: string; // served /assets/... URL from uploadAsset ("" until uploaded)
  box_x: number; // placement box, fractions 0..1 of the frame (default full-frame)
  box_y: number;
  box_w: number;
  box_h: number;
  fit: LayerFit; // how the asset scales into the box
  ports: Record<string, FluidPort>;
}
// A solid-colour full-frame fill, output as a video layer — the bottom layer of a stack
// combine for a non-black background. `color` is a hex swatch; `opacity` is a port.
export interface BackdropData {
  color: string; // hex fill colour
  ports: Record<string, FluidPort>;
}
// A video layer adds playback timing on top of the image placement fields. `speed` is a
// modulatable port (in `ports`), not a static field — a wired signal time-warps the clip.
export interface VideoData extends ImageData {
  sync: "song" | "segment"; // clock the playhead to the whole song or just this segment
  start: number; // start offset into the source, seconds
  loop: boolean; // loop the clip if it's shorter than the window
}
// The image-generator / slideshow layer: N stills, advanced by the `trigger` port —
// each rising edge past the built-in hysteresis threshold shows the NEXT image
// (wrapping). `prompt`/`seed` feed the local image generation (part B); the images
// themselves are ordinary content-addressed assets, however they were made.
export interface ImagegenData {
  assetUrls: string[]; // ordered slideshow (served /assets/... URLs)
  box_x: number; // placement box, fractions 0..1 (same semantics as ImageData)
  box_y: number;
  box_w: number;
  box_h: number;
  fit: LayerFit;
  threshold: number; // trigger level the built-in gate switches around
  hysteresis: number; // dead band so a hovering trigger can't machine-gun images
  prompt: string; // text prompt for ✨ generate
  seed: number; // generation seed (deterministic; bump for new variations)
  ports: Record<string, FluidPort>;
}

// A per-project library asset (image/video), owned by the backend `data.assets`.
export interface Asset {
  id: string; // content hash (sha16)
  url: string; // served /assets/<job>/<name>
  kind: "image" | "video";
  name: string; // original filename / display name
  addedAt: number; // unix seconds
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
export interface GateNode extends NodeBase {
  type: "gate";
  data: GateData;
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
export interface ImageNode extends NodeBase {
  type: "image";
  data: ImageData;
}
export interface VideoNode extends NodeBase {
  type: "video";
  data: VideoData;
}
export interface ImagegenNode extends NodeBase {
  type: "imagegen";
  data: ImagegenData;
}
export interface BackdropNode extends NodeBase {
  type: "backdrop";
  data: BackdropData;
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
  | GateNode
  | ScopeNode
  | PatternNode
  | AnimatePointsNode
  | MergePointsNode
  | ColorNode
  | LyricsNode
  | ImageNode
  | VideoNode
  | ImagegenNode
  | BackdropNode;

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
  // Which cards show their FULL body on the canvas (v13+); everything else renders
  // as a compact card. Ignored by outputHash so toggling never busts the render cache.
  expanded?: string[];
  // Legacy pre-v13 field (the inverse set: which cards were collapsed). normalizeGraph
  // inverts it into `expanded` and strips it; typed here so the migration can read it.
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
