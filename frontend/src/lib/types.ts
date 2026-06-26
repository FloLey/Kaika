// Core domain types for the animation graph + render settings — the typed
// counterpart to the runtime shapes in lib/graph/* and output.ts. Node `data` is a
// discriminated union keyed on `type`, so `node.data.*` access is checked once the
// node's type is narrowed (e.g. `if (node.type === "fluid") node.data.ports`).

export type Quality = "draft" | "normal" | "high";

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

export type GraphNode = SignalNode | FluidNode | CombineNode | PointsNode | OutputNode;

export type NodeType = GraphNode["type"];

// One node's `data` for a given type (e.g. NodeData<"fluid"> = FluidData).
export type NodeOf<T extends NodeType> = Extract<GraphNode, { type: T }>;

export type PortFlow = "value" | "video" | "points";

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

// One fluid param spec entry (generated into fluidParams.js from the backend).
export interface FluidParam {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  def: number;
  group: "source" | "color" | "medium";
  fmt?: (v: number) => string;
}
