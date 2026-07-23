// Shared graph-model primitives: id makers, the ports structural guard, port
// coercion, and the video-producer sets. The leaf module of lib/graph — every
// other module imports from here, keeping the split cycle-free.

import { FLUID_PARAMS as RAW_FLUID_PARAMS } from "../fluidParams.js";
import { nodeParams } from "../nodeParams";
import type { FluidPort, Graph, GraphEdge, GraphNode } from "../types";

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
  "text",
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

// Generated from backend/graph_common.py — the two sides must name the same cards, and
// this used to be a hand-kept third copy of the concept. VIDEO_SOURCES / VIDEO_FX above
// stay hand-written: they are FRONTEND groupings encoding a rendering rule the backend
// has no notion of (FX cards need their `video` input wired; never emitter sources).
// `graphConstants.test.ts` asserts the groupings still add up to the generated set.
export { VIDEO_PRODUCERS } from "./generated";

// The node wired into (targetId, targetPort) via a video edge, or null.
export function videoSource(graph: Graph, targetId: string, targetPort: string): string | null {
  const e = (graph.edges || []).find((x) => x.target === targetId && x.targetPort === targetPort);
  return e ? e.source : null;
}

// The graph's edges, each one carrying the SLOT INDEX it feeds when its target is a
// slot card (montage / combine). Slot order is meaningful — a montage plays slot 1
// first — and ✨ arrange uses this to stack the feeders in that order rather than
// wherever crossing-minimisation happens to drop them (`flowLayout`, graph/layout).
export function rankedEdges(graph: Graph): (GraphEdge & { portRank?: number })[] {
  const ranks = new Map<string, Map<string, number>>();
  for (const n of graph.nodes || []) {
    const inputs = (n.data as { inputs?: unknown }).inputs;
    if (!Array.isArray(inputs)) continue;
    const byId = new Map<string, number>();
    inputs.forEach((s, i) => {
      if (s && typeof s === "object" && typeof (s as { id?: unknown }).id === "string") {
        byId.set((s as { id: string }).id, i);
      }
    });
    if (byId.size) ranks.set(n.id, byId);
  }
  if (!ranks.size) return graph.edges || [];
  return (graph.edges || []).map((e) => {
    const rank = ranks.get(e.target)?.get(e.targetPort);
    return rank == null ? e : { ...e, portRank: rank };
  });
}

// (feedsMontage died with slot wiring: no video edge can end in a montage now —
// its children are composition references.)

// The "loose edge" sentinel targetPort: a wire dropped on a card whose destination
// port couldn't be auto-resolved. Loose edges draw gray, carry NO binding, and are
// INVISIBLE to validation, renderability and the output hash (both frontends of the
// contract filter them; the backend mirrors it) — they're a UI parking state until
// the settings window assigns a real port.
export const LOOSE_PORT = "__in";
export const isLooseEdge = (e: { targetPort: string }): boolean => e.targetPort === LOOSE_PORT;

// Composition ids a graph references DIRECTLY — the montage card's extracts
// (`data.extracts[].compositionId`; the field lands with the extracts step, so this
// reads empty on older montage shapes). Mirrors backend
// `compositions.referenced_composition_ids`.
export function referencedCompositionIds(graph: Graph | null | undefined): Set<string> {
  const ids = new Set<string>();
  for (const n of graph?.nodes || []) {
    if (n.type !== "montage") continue;
    const extracts = (n.data as { extracts?: { compositionId?: string }[] }).extracts;
    for (const ex of extracts || []) {
      if (ex?.compositionId) ids.add(ex.compositionId);
    }
  }
  return ids;
}
