// Core domain types for the animation graph + render settings — the typed
// counterpart to the runtime shapes in graphModel.js / output.js. As modules
// convert to .ts (Batch 10), they import these instead of re-describing shapes.

export type Quality = "draft" | "normal" | "high";

export interface OutputSettings {
  width: number;
  height: number;
  quality: Quality;
  fps: number;
  background: string;
}

// A fluid param port binding: a constant value, or a value-source node whose 0..1
// curve maps into [lo, hi] (native units).
export type Binding =
  | { kind: "const"; value: number }
  | { kind: "node"; nodeId: string; lo: number; hi: number };

export type NodeType = "signal" | "fluid" | "combine" | "points" | "output";

export interface GraphNode {
  id: string;
  type: NodeType;
  x: number;
  y: number;
  // Per-type payload (ports/static for fluid, points for points, etc.). Kept open
  // until each node type's data shape is pinned during conversion.
  data: Record<string, unknown>;
}

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
