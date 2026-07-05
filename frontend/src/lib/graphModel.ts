// The graph data model (01 §3.1–3.7) — the thin public barrel over lib/graph/.
// Framework-free. Import from here (components and tests do); the implementation
// is split by responsibility:
//
//   graph/core       id makers, ports guard/coercion, video-producer sets
//   graph/factories  node factories + GRAPH_VERSION / emptyGraph
//   graph/mutations  immutable graph edits (keep the §3.3 binding<->edge invariant)
//   graph/normalize  normalizeGraph — schema-driven migration of older saves
//   graph/validate   validate / outputRenderable (§3.7), contributing-subgraph walk
//   graph/hash       outputHash — the per-output render-POST gate (§3.6)

export { mkNodeId, mkEdgeId, VIDEO_SOURCES, VIDEO_PRODUCERS, videoSource } from "./graph/core";
export {
  GRAPH_VERSION,
  COLOR_STOPS_DEFAULT,
  emptyGraph,
  combineSlot,
  signalNode,
  outputNode,
  fluidNode,
  combineNode,
  pointsNode,
  mathNode,
  lfoNode,
  noiseNode,
  shaperNode,
  scopeNode,
  patternNode,
  animatePointsNode,
  mergePointsNode,
  colorNode,
  lyricsNode,
  imageNode,
  videoNode,
  backdropNode,
} from "./graph/factories";
export {
  patchNodeData,
  addInputPort,
  removeInputPort,
  addPoint,
  movePoint,
  removePoint,
  connectVideo,
  addCombineInput,
  removeCombineInput,
  setCombineMode,
  setCombineOpacity,
  setCombineMedium,
  setCombineLayer,
  connect,
  disconnect,
  removeNode,
} from "./graph/mutations";
export { normalizeGraph } from "./graph/normalize";
export { validate, videoInput, outputRenderable } from "./graph/validate";
export { outputHash } from "./graph/hash";
