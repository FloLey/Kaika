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
//   graph/layout     de-overlap / tighten passes for the per-view card positions

export {
  mkNodeId,
  mkEdgeId,
  LOOSE_PORT,
  isLooseEdge,
  VIDEO_SOURCES,
  VIDEO_PRODUCERS,
  videoSource,
  feedsMontage,
  rankedEdges,
} from "./graph/core";
export {
  GRAPH_VERSION,
  COLOR_STOPS_DEFAULT,
  emptyGraph,
  combineSlot,
  montageSlot,
  montageNode,
  signalNode,
  outputNode,
  fluidNode,
  combineNode,
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
  extractNode,
  echoNode,
  colorgradeNode,
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
  addAssetCard,
  addMontageInput,
  fillMontageSlots,
  removeMontageInput,
  setMontageSlotSpan,
  setCombineMode,
  setCombineOpacity,
  setCombineMedium,
  setCombineLayer,
  connect,
  disconnect,
  removeNode,
  resolveDropPort,
  connectLoose,
  assignEdge,
  unassignEdge,
  renameNode,
} from "./graph/mutations";
export { normalizeGraph } from "./graph/normalize";
export { resolveOverlaps, tighten, flowLayout, estimateCardSize, FLOW_GAPS } from "./graph/layout";
export type { LayoutRect, CardSize, FlowGaps } from "./graph/layout";
export { validate, videoInput, outputRenderable, nodeRenderable } from "./graph/validate";
export { outputHash, upstreamKey } from "./graph/hash";
export { problemsFor } from "./graph/problems";
export type { GraphProblem } from "./graph/problems";
