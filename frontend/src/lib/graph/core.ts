// Shared graph-model primitives: id makers, the ports structural guard, port
// coercion, and the video-producer sets. The leaf module of lib/graph — every
// other module imports from here, keeping the split cycle-free.

import { FLUID_PARAMS as RAW_FLUID_PARAMS } from "../fluidParams.js";
import { nodeParams } from "../nodeParams";
import type { FluidPort, Graph, GraphNode } from "../types";

// A node's modulatable-port map, or null if the card type has none. Several card
// types carry `data.ports` (fluid + the FX cards); this is the structural guard used
// by the generic binding helpers.
export const portsOf = (n: GraphNode): Record<string, FluidPort> | null =>
  n.data && typeof n.data === "object" && "ports" in n.data
    ? (n.data as { ports: Record<string, FluidPort> }).ports
    : null;

// Coerce a saved `ports` map to EXACTLY a node type's current param spec — a new
// param gets a default const port; a removed one is dropped. Used by normalizeGraph.
export const coercePorts = (
  type: string,
  old: Record<string, FluidPort> | undefined
): Record<string, FluidPort> => {
  const ports: Record<string, FluidPort> = {};
  for (const p of nodeParams(type)) {
    ports[p.key] = old?.[p.key] || { binding: { kind: "const", value: p.def } };
  }
  return ports;
};

// fluidParams.js is untyped JS; pin the shapes the graph model relies on.
export const FLUID_PARAMS = RAW_FLUID_PARAMS as {
  key: string;
  def: number;
  min: number;
  max: number;
}[];

// Same id convention as segments.js `rid`: "<prefix>-<8 chars>".
const rid = (p: string): string => {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return `${p}-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${p}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
};

export const mkNodeId = (): string => rid("n");
export const mkEdgeId = (): string => rid("e");
export const mkInputId = (): string => rid("in");
export const mkSlotId = (): string => rid("slot");

// Non-fluid video sources (no video input; synthesise frames). Producers, not emitters.
export const VIDEO_SOURCES = new Set<string>([
  "lyrics",
  "image",
  "slideshow",
  "video",
  "backdrop",
  "waves",
  "lightning",
  "fire",
  "aurora",
  "rain",
  "clouds",
]);

// Video-FX cards: video in -> video out. They pass a stream through a per-frame op, so
// (like `output`) they're renderable only with their `video` input wired — see
// `nodeRenderable`. Never emitter sources: a merge combine needs raw fluid emitters.
export const VIDEO_FX = new Set<string>(["transform", "stylize", "extract", "echo", "colorgrade"]);

export const VIDEO_PRODUCERS = new Set<string>([
  "fluid",
  "combine",
  "montage", // N slot inputs like combine (slot id = targetPort), so not VIDEO_FX
  "output",
  ...VIDEO_SOURCES,
  ...VIDEO_FX,
]);

// The node wired into (targetId, targetPort) via a video edge, or null.
export function videoSource(graph: Graph, targetId: string, targetPort: string): string | null {
  const e = (graph.edges || []).find((x) => x.target === targetId && x.targetPort === targetPort);
  return e ? e.source : null;
}

// Whether a card's stream ends up in a montage SLOT (directly or through an FX /
// combine chain). Mirrors backend `_feeds_a_montage`: a montage RE-TIMES its inputs
// (local frame 0 lands on the cut), so an upstream video card ignores the song clock
// — both when rendering and when previewing.
export function feedsMontage(graph: Graph | undefined, nodeId: string): boolean {
  if (!graph) return false;
  const downstream = new Map<string, string[]>();
  for (const e of graph.edges || []) {
    if (isLooseEdge(e)) continue;
    if (!downstream.has(e.source)) downstream.set(e.source, []);
    downstream.get(e.source)!.push(e.target);
  }
  const byId = new Map((graph.nodes || []).map((n) => [n.id, n.type]));
  const seen = new Set([nodeId]);
  const stack = [...(downstream.get(nodeId) || [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (byId.get(id) === "montage") return true;
    stack.push(...(downstream.get(id) || []));
  }
  return false;
}

// The "loose edge" sentinel targetPort: a wire dropped on a card whose destination
// port couldn't be auto-resolved. Loose edges draw gray, carry NO binding, and are
// INVISIBLE to validation, renderability and the output hash (both frontends of the
// contract filter them; the backend mirrors it) — they're a UI parking state until
// the settings window assigns a real port.
export const LOOSE_PORT = "__in";
export const isLooseEdge = (e: { targetPort: string }): boolean => e.targetPort === LOOSE_PORT;
