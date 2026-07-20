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
/** One aligned lyric line. The shape was documented in a COMMENT on nodeProps'
 * `lyricLines?: unknown[]` and threaded untyped through six modules; the lyrics card,
 * the render key and the line editor all index into it. */
export interface LyricLine {
  t0: number;
  t1: number;
  text: string;
  aligned?: boolean; // false = interpolated timing, not actually heard
}

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
  minGap: number; // min seconds between spikes — rises closer than this are dropped (0 = off)
  divide: number; // keep only every Nth spike (1/N divider; 1 = keep all)
  invert: boolean; // flip the output (1 while BELOW the threshold)
}

// Derivative detector: how fast the input is CHANGING (units/second, smoothed) — feed
// a gate to trigger on musical change (verse→chorus, drops) rather than on level.
export interface ChangeData {
  gain: number; // scale on the change rate (a 0→1 sweep over 1s reads ≈1.0 before gain)
  attack: number; // ms — how fast the output reacts to a burst of change
  release: number; // ms — how long the bump lingers (slow, so a gate sees one clean pulse)
  direction: "both" | "rise" | "fall"; // |Δ|, rises only, or falls only
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
// Generative source cards (specs/generative-cards/): synthesise an RGBA layer from
// scratch, reactive to signal-driven ports. Colour is a static `palette` preset,
// overridable by a `color` card wired into the "color" input. `seed` varies the noise.
// The six generative simulation cards. Identical shape — a palette, a seed and the
// modulatable ports — so only the palette union differs; six copies of the same three
// fields drifted apart the moment one gained a field the others didn't.
export interface GenSourceData<P extends string> {
  palette: P;
  seed: number;
  ports: Record<string, FluidPort>;
}
export type WavesData = GenSourceData<"ocean" | "tropical" | "storm" | "sunset">;
export type LightningData = GenSourceData<"electric" | "violet" | "white-hot" | "ember">;
export type FireData = GenSourceData<"flame" | "blue-fire" | "green-fire" | "ghost">;
export type AuroraData = GenSourceData<"aurora" | "solar" | "ice" | "spectrum">;
export type RainData = GenSourceData<"downpour" | "silver" | "neon" | "monsoon">;
export type CloudsData = GenSourceData<"sky" | "nebula" | "ink" | "dust">;
// The transform video-FX card (video -> video): an affine warp of the incoming frames
// (zoom/rotate/pan are modulatable ports), optionally folded into a mirror or a
// kaleidoscope. `wrap` tiles the edges instead of leaving them black.
export interface TransformData {
  mode: "transform" | "mirror" | "kaleidoscope";
  segments: number; // kaleidoscope wedge count, 2..12
  wrap: boolean;
  ports: Record<string, FluidPort>;
}
// The AI Stylize card (video → video): img2img of the upstream fluid toward `prompt`.
// `strength` is a modulatable port (in `ports`). `inpaint` confines the repaint to the
// fluid's shape. `assetUrl` is the generated clip (empty → passes the fluid through).
export interface StylizeData {
  model: "draft" | "hd";
  inpaint: boolean;
  prompt: string;
  assetUrl: string; // "" until Generate; a served /assets/... mp4 once generated
  ports: Record<string, FluidPort>;
}
// The Extract card (video → video): turns any video into a control image (canny edges /
// soft-edge) for feeding a ControlNet — wire its output into AI Stylize's `control` input.
export interface ExtractData {
  kind: "canny" | "soft" | "density" | "depth";
  ports: Record<string, FluidPort>;
}
// The Echo look-FX card (video → video): motion trails — movement leaves fading ghosts.
// `mode` picks the memory: `ghost` = translucent afterimages of every change (real
// footage), `bright` = decayed running max (comet tails on dark backgrounds; black stays
// black), `dark` = its mirror (shadow trails behind dark subjects on bright scenes).
// `length` (trail half-life, seconds) and `amount` (dry↔trail mix) are modulatable ports.
export interface EchoData {
  mode: "ghost" | "bright" | "dark";
  ports: Record<string, FluidPort>;
}
// The Color Grade look-FX card (video → video): recolour the stream. `thermal` maps
// luminance through a heat colormap (`map`), `duotone` onto a colorA→colorB ramp,
// `neon` draws glowing edges on black. A `color` card wired into the `tint` input
// overrides colorB (gradient + bound position = colour sweeps with the music).
// `intensity` (dry↔graded / glow gain) and `shift` (LUT roll / midpoint / hue) are
// modulatable ports.
export interface ColorGradeData {
  mode: "thermal" | "duotone" | "neon";
  map: "turbo" | "inferno" | "jet" | "ocean"; // thermal only
  colorA: string; // duotone shadow hex
  colorB: string; // duotone highlight / neon glow hex (a wired tint overrides it)
  ports: Record<string, FluidPort>;
}
// A video layer adds playback timing on top of the image placement fields. `speed` is a
// modulatable port (in `ports`), not a static field — a wired signal time-warps the clip.
// `crop_*` selects a region of the SOURCE frame (fractions, default all of it) — that
// region is what gets fitted into the placement box, so a clip too wide/tall for the
// project format shows exactly the part the user picked.
export interface VideoData extends ImageData {
  sync: "song" | "segment"; // clock the playhead to the whole song or just this segment
  start: number; // start offset into the source, seconds
  loop: boolean; // loop the clip if it's shorter than the window
  crop_x: number; // source crop, fractions 0..1 of the source frame (default full-frame)
  crop_y: number;
  crop_w: number;
  crop_h: number;
}
// One own pick of the slideshow: an image OR a video clip, in display order. `kind` is
// set at add-time (upload/library returns it), inferred from the URL extension as a
// fallback. `start` is the video in-point in seconds (where the extract begins) — the
// display DURATION is driven by the trigger signal, so only the start is user-chosen;
// omitted / ignored for images.
export interface SlideshowItem {
  url: string; // served /assets/... URL
  kind: "image" | "video";
  start?: number; // videos only: in-point seconds (default 0)
}
// The slideshow layer: N ordered items (images and/or video clips), advanced by the
// `trigger` port — each rising edge past the built-in hysteresis threshold shows the
// NEXT item (wrapping). Items come from the card's own picks (uploads / the library),
// draggable to reorder, PLUS image items wired into its `images` input (an Image gen
// card's generated list, appended after the own picks). A video item plays from its
// in-point for as long as the trigger keeps it visible (looping past the clip end);
// revisiting it later restarts from the in-point.
export interface SlideshowData {
  items: SlideshowItem[]; // the card's OWN ordered picks (was assetUrls: string[])
  box_x: number; // placement box, fractions 0..1 (same semantics as ImageData)
  box_y: number;
  box_w: number;
  box_h: number;
  fit: LayerFit;
  threshold: number; // trigger level the built-in gate switches around
  hysteresis: number; // dead band so a hovering trigger can't machine-gun images
  ports: Record<string, FluidPort>;
}
// One montage input slot — its id is the targetPort the slot's video edge wires to
// (combine-slot convention). All per-clip data (in-point, crop, speed…) lives on the
// upstream card. `span` is how many trigger cuts the slot swallows (default 1; a ×2
// slot plays through two gate intervals) — kept ABSENT at 1 so untouched graphs
// hash identically.
export interface MontageSlot {
  id: string;
  span?: number;
}
// The montage switcher (video récap use-case): N wired video inputs, cut in ORDER by
// the `trigger` port — each rising edge past the built-in hysteresis threshold starts
// the NEXT slot, whose input is RE-TIMED to begin at the cut (an upstream video card's
// in-point lands exactly on the beat). Rises beyond the input count are ignored: the
// last input holds to the segment end. Each slot's upstream chain must be exclusive
// to it (block streaming re-times the producer — validate enforces this).
export interface MontageData {
  inputs: MontageSlot[];
  threshold: number; // trigger level the built-in gate switches around
  hysteresis: number; // dead band so a hovering trigger can't machine-gun cuts
  ports: Record<string, FluidPort>;
}
// The image GENERATOR: one prompt per image, generated locally (seeded) into a list
// of content-addressed assets. Not a video producer — its `images` output wires into
// a Slideshow card's `images` input.
export interface ImagegenData {
  prompts: string[]; // one image per prompt — the card shows the count
  seed: number; // generation seed (image i uses seed + i; deterministic)
  assetUrls: string[]; // the generated results, aligned 1:1 with prompts by index
  model?: string; // which model the ✨ draft uses (export always regenerates in HD)
  activeCount?: number; // set by a wired gate: only the first N images are shown + output
}

// A per-project library asset (image/video), owned by the backend `data.assets`.
export interface Asset {
  id: string; // content hash (sha16)
  url: string; // served /assets/<job>/<name>
  kind: "image" | "video";
  name: string; // original filename / display name
  addedAt: number; // unix seconds
  folder?: string; // relative display path ("May 2026/venise") — the library groups by it
  duration?: number; // videos: seconds, ffprobed on upload (the montage's slot warning)
}

// ---- the discriminated node union --------------------------------------------
interface NodeBase {
  id: string;
  x: number;
  y: number;
  // The card's position in the COMPACT view (v20). `x/y` stays the detailed
  // (canonical) position, so each view keeps its own arrangement — compact stays
  // tight, detailed stays spread. Absent = derived on the next compact entry.
  // Node-level like `name`: invisible to outputHash, so moving cards in either
  // view can never bust the render cache.
  cx?: number;
  cy?: number;
  // A human-friendly card name (default "<type> N", editable). NODE-level on purpose:
  // outputHash serializes only {id,type,data}, so renaming never busts the render
  // cache. Optional + lazily defaulted, so it round-trips normalizeGraph untouched.
  name?: string;
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
export interface ChangeNode extends NodeBase {
  type: "change";
  data: ChangeData;
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
export interface SlideshowNode extends NodeBase {
  type: "slideshow";
  data: SlideshowData;
}
export interface MontageNode extends NodeBase {
  type: "montage";
  data: MontageData;
}
export interface ImagegenNode extends NodeBase {
  type: "imagegen";
  data: ImagegenData;
}
export interface BackdropNode extends NodeBase {
  type: "backdrop";
  data: BackdropData;
}

export interface WavesNode extends NodeBase {
  type: "waves";
  data: WavesData;
}

export interface LightningNode extends NodeBase {
  type: "lightning";
  data: LightningData;
}

export interface FireNode extends NodeBase {
  type: "fire";
  data: FireData;
}

export interface AuroraNode extends NodeBase {
  type: "aurora";
  data: AuroraData;
}

export interface RainNode extends NodeBase {
  type: "rain";
  data: RainData;
}

export interface CloudsNode extends NodeBase {
  type: "clouds";
  data: CloudsData;
}

export interface TransformNode extends NodeBase {
  type: "transform";
  data: TransformData;
}

export interface StylizeNode extends NodeBase {
  type: "stylize";
  data: StylizeData;
}

export interface ExtractNode extends NodeBase {
  type: "extract";
  data: ExtractData;
}

export interface EchoNode extends NodeBase {
  type: "echo";
  data: EchoData;
}

export interface ColorGradeNode extends NodeBase {
  type: "colorgrade";
  data: ColorGradeData;
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
  | ChangeNode
  | ScopeNode
  | PatternNode
  | AnimatePointsNode
  | MergePointsNode
  | ColorNode
  | LyricsNode
  | ImageNode
  | VideoNode
  | SlideshowNode
  | MontageNode
  | ImagegenNode
  | BackdropNode
  | WavesNode
  | LightningNode
  | FireNode
  | AuroraNode
  | RainNode
  | CloudsNode
  | TransformNode
  | StylizeNode
  | ExtractNode
  | EchoNode
  | ColorGradeNode;

export type NodeType = GraphNode["type"];

// One node's `data` for a given type (e.g. NodeData<"fluid"> = FluidData).
export type NodeOf<T extends NodeType> = Extract<GraphNode, { type: T }>;

export type PortFlow = "value" | "video" | "points" | "color" | "images";

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
  // The canvas view mode (v16): "detailed" (classic full cards — the default when
  // absent) or "compact" (name + preview). Switched from the toolbar; ignored by
  // outputHash, so flipping never busts the render cache.
  viewMode?: "detailed" | "compact";
  // Cards displayed OPPOSITE to the current mode (the per-card ▢/– override).
  // Cleared when the mode switches — a clean flip.
  viewOverrides?: string[];
  // Legacy view-state fields (pre-v16 `expanded`, pre-v13 `minimized`). normalizeGraph
  // strips both; typed here so the migration can read them.
  expanded?: string[];
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
