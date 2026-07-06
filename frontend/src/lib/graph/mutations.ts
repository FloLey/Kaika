// Graph mutation helpers. All immutably return a new Graph and keep the
// binding<->edge invariant (01 §3.3): wiring a value source writes BOTH the port
// binding and the edge; removing a node resets any binding that pointed at it.

import { LOOSE_PORT, isLooseEdge, mkEdgeId, mkInputId, portsOf, videoSource } from "./core";
import { combineSlot } from "./factories";
import { nodeParam } from "../nodeParams";
import type { Binding, CombineMedium, CombineNode, Graph, GraphNode } from "../types";

// Shallow-merge a patch into a node's `data` (op/knob/param edits on the simple
// value cards). Generic across node types — the caller passes a typed patch.
export function patchNodeData(graph: Graph, id: string, patch: Record<string, unknown>): Graph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.id === id ? ({ ...n, data: { ...n.data, ...patch } } as GraphNode) : n
    ),
  };
}

// Add / remove an input port on a node carrying `data.inputs: string[]` (the Math
// card). Removing also drops any edge wired into that port (keeps the graph clean).
export function addInputPort(graph: Graph, id: string): Graph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.id === id && "inputs" in n.data
        ? ({ ...n, data: { ...n.data, inputs: [...n.data.inputs, mkInputId()] } } as GraphNode)
        : n
    ),
  };
}
export function removeInputPort(graph: Graph, id: string, portId: string): Graph {
  const nodes = graph.nodes.map((n) =>
    n.id === id && "inputs" in n.data
      ? ({
          ...n,
          data: { ...n.data, inputs: n.data.inputs.filter((p) => p !== portId) },
        } as GraphNode)
      : n
  );
  const edges = graph.edges.filter((e) => !(e.target === id && e.targetPort === portId));
  return { ...graph, nodes, edges };
}

type Point = [number, number];
const patchPoints = (graph: Graph, id: string, fn: (pts: Point[]) => Point[]): Graph => ({
  ...graph,
  nodes: graph.nodes.map((n) =>
    n.id === id && n.type === "points"
      ? { ...n, data: { ...n.data, points: fn(n.data.points || []) } }
      : n
  ),
});
export function addPoint(graph: Graph, id: string, p: Point): Graph {
  return patchPoints(graph, id, (pts) => [...pts, [p[0], p[1]]]);
}
export function movePoint(graph: Graph, id: string, i: number, p: Point): Graph {
  return patchPoints(graph, id, (pts) => pts.map((q, k) => (k === i ? [p[0], p[1]] : q)));
}
export function removePoint(graph: Graph, id: string, i: number): Graph {
  return patchPoints(graph, id, (pts) => pts.filter((_, k) => k !== i));
}

// Wire a video producer into a target port (output "video" or a combine slot id);
// last-wins (replaces any existing edge into that port).
export function connectVideo(
  graph: Graph,
  sourceId: string,
  sourcePort: string,
  targetId: string,
  targetPort: string
): Graph {
  const edges = (graph.edges || []).filter(
    (e) => !(e.target === targetId && e.targetPort === targetPort)
  );
  edges.push({ id: mkEdgeId(), source: sourceId, sourcePort, target: targetId, targetPort });
  return { ...graph, edges };
}

const patchCombine = (
  graph: Graph,
  combineId: string,
  fn: (d: CombineNode["data"]) => CombineNode["data"]
): Graph => ({
  ...graph,
  nodes: graph.nodes.map((n) =>
    n.id === combineId && n.type === "combine" ? { ...n, data: fn(n.data) } : n
  ),
});

export function addCombineInput(graph: Graph, combineId: string): Graph {
  return patchCombine(graph, combineId, (d) => ({ ...d, inputs: [...d.inputs, combineSlot()] }));
}
export function removeCombineInput(graph: Graph, combineId: string, slotId: string): Graph {
  const g = patchCombine(graph, combineId, (d) => ({
    ...d,
    inputs: d.inputs.filter((s) => s.id !== slotId),
  }));
  return {
    ...g,
    edges: g.edges.filter((e) => !(e.target === combineId && e.targetPort === slotId)),
  };
}
export function setCombineMode(graph: Graph, combineId: string, mode: "merge" | "stack"): Graph {
  return patchCombine(graph, combineId, (d) => ({ ...d, mode }));
}
export function setCombineOpacity(
  graph: Graph,
  combineId: string,
  slotId: string,
  opacity: number
): Graph {
  return patchCombine(graph, combineId, (d) => ({
    ...d,
    inputs: d.inputs.map((s) => (s.id === slotId ? { ...s, opacity } : s)),
  }));
}
export function setCombineMedium(
  graph: Graph,
  combineId: string,
  key: keyof CombineMedium,
  value: number
): Graph {
  return patchCombine(graph, combineId, (d) => ({ ...d, medium: { ...d.medium, [key]: value } }));
}
// Cross-segment continuity layer (data.layer) — carries the composed sim across cuts.
export function setCombineLayer(graph: Graph, combineId: string, layer: number): Graph {
  return patchCombine(graph, combineId, (d) => ({ ...d, layer }));
}

// ---- wiring (keeps the §3.3 binding<->edge invariant) ------------------------

// Wire a value-source node into a modulatable param (fluid or an FX card): writes
// BOTH the binding and the edge. lo/hi default to the param range (maps source
// 0..1 -> native units).
export function connect(graph: Graph, sourceId: string, targetId: string, paramKey: string): Graph {
  const node = graph.nodes.find((n) => n.id === targetId);
  const p = node ? nodeParam(node.type, paramKey) : undefined;
  const ports = node ? portsOf(node) : null;
  if (!p || !ports) return graph;
  ports[paramKey] = { binding: { kind: "node", nodeId: sourceId, lo: p.min, hi: p.max } };
  const edges = graph.edges.filter((e) => !(e.target === targetId && e.targetPort === paramKey));
  edges.push({
    id: mkEdgeId(),
    source: sourceId,
    sourcePort: "out",
    target: targetId,
    targetPort: paramKey,
  });
  return { ...graph, edges };
}

// Clear a wired param back to its default constant, dropping the edge.
export function disconnect(graph: Graph, targetId: string, paramKey: string): Graph {
  const node = graph.nodes.find((n) => n.id === targetId);
  const p = node ? nodeParam(node.type, paramKey) : undefined;
  const ports = node ? portsOf(node) : null;
  if (!p || !ports) return graph;
  ports[paramKey] = { binding: { kind: "const", value: p.def } };
  return {
    ...graph,
    edges: graph.edges.filter((e) => !(e.target === targetId && e.targetPort === paramKey)),
  };
}

// Drop a node, its incident edges, and reset any port bound to it (on any ported
// card) back to the param default constant (so no binding dangles — §3.3 invariant).
export function removeNode(graph: Graph, nodeId: string): Graph {
  const nodes = graph.nodes
    .filter((n) => n.id !== nodeId)
    .map((n): GraphNode => {
      const srcPorts = portsOf(n);
      if (!srcPorts) return n;
      let touched = false;
      const ports: Record<string, { binding: Binding }> = {};
      for (const [key, port] of Object.entries(srcPorts)) {
        const b = port.binding;
        if (b && b.kind === "node" && b.nodeId === nodeId) {
          ports[key] = { ...port, binding: { kind: "const", value: nodeParam(n.type, key)?.def ?? 0 } };
          touched = true;
        } else {
          ports[key] = port;
        }
      }
      if (!touched) return n;
      return { ...n, data: { ...n.data, ports } } as GraphNode;
    });
  const edges = graph.edges.filter((e) => e.source !== nodeId && e.target !== nodeId);
  const out: Graph = { ...graph, nodes, edges };
  // Drop the removed node from the persisted expand set (no stale ids) — and from the
  // legacy pre-v13 minimize set, in case a save is mutated before normalizeGraph ran.
  if (Array.isArray(graph.expanded) && graph.expanded.includes(nodeId)) {
    out.expanded = graph.expanded.filter((id) => id !== nodeId);
  }
  if (Array.isArray(graph.minimized) && graph.minimized.includes(nodeId)) {
    out.minimized = graph.minimized.filter((id) => id !== nodeId);
  }
  return out;
}

// ---- loose edges (drop-anywhere wiring) ---------------------------------------
// A wire dropped on a CARD (not a specific port) auto-assigns when the destination
// is unambiguous; otherwise it lands as a LOOSE edge (targetPort "__in", no binding,
// drawn gray, ignored by validate/hash) until the settings window assigns a port.

// The port a dropped wire should land on, or null when ambiguous (-> loose):
//   video flow  -> an output's `video` port, or a combine's first FREE slot
//   points flow -> a fluid's `positions` input
//   value flow  -> the target's ONLY unbound modulatable port (else ambiguous)
//   color flow  -> the target's only unwired color input (lyrics fill/outline, fluid color)
export function resolveDropPort(
  graph: Graph,
  targetId: string,
  flow: string
): string | null {
  const node = graph.nodes.find((n) => n.id === targetId);
  if (!node) return null;
  if (flow === "video") {
    if (node.type === "output") return videoSource(graph, targetId, "video") ? null : "video";
    if (node.type === "combine") {
      const free = node.data.inputs.find((s) => !videoSource(graph, targetId, s.id));
      return free ? free.id : null;
    }
    return null;
  }
  if (flow === "points") {
    return node.type === "fluid" && !videoSource(graph, targetId, "positions") ? "positions" : null;
  }
  if (flow === "color") {
    const candidates =
      node.type === "lyrics" ? ["fillColor", "outlineColor"] : node.type === "fluid" ? ["color"] : [];
    const free = candidates.filter((p) => !videoSource(graph, targetId, p));
    return free.length === 1 ? free[0] : null;
  }
  // value: the only modulatable port still holding a const binding.
  const ports = portsOf(node);
  if (!ports) return null;
  const unbound = Object.entries(ports)
    .filter(([, p]) => !p.binding || p.binding.kind === "const")
    .map(([k]) => k);
  return unbound.length === 1 ? unbound[0] : null;
}

// Park a wire on the card: a real edge with the LOOSE sentinel targetPort and no
// binding — the documented exception to the binding<->edge invariant. One loose
// edge per (source, target) pair (re-dropping the same wire is a no-op).
export function connectLoose(graph: Graph, sourceId: string, targetId: string): Graph {
  if (
    (graph.edges || []).some(
      (e) => e.source === sourceId && e.target === targetId && isLooseEdge(e)
    )
  ) {
    return graph;
  }
  return {
    ...graph,
    edges: [
      ...graph.edges,
      { id: mkEdgeId(), source: sourceId, sourcePort: "out", target: targetId, targetPort: LOOSE_PORT },
    ],
  };
}

// Promote a loose edge onto a real port: for a modulatable param this IS `connect`
// (binding + edge written together — the invariant holds again); for the special
// inputs (video/positions/color) it's a plain retarget. The loose edge is dropped
// either way (connect/connectVideo replace any existing edge into that port).
export function assignEdge(graph: Graph, edgeId: string, portKey: string): Graph {
  const edge = (graph.edges || []).find((e) => e.id === edgeId);
  if (!edge || !isLooseEdge(edge)) return graph;
  const without = { ...graph, edges: graph.edges.filter((e) => e.id !== edgeId) };
  const target = graph.nodes.find((n) => n.id === edge.target);
  if (target && nodeParam(target.type, portKey)) {
    return connect(without, edge.source, edge.target, portKey);
  }
  return connectVideo(without, edge.source, edge.sourcePort, edge.target, portKey);
}

// Demote an assigned input back to loose: clear the binding (for a param port) and
// re-park the wire on the card.
export function unassignEdge(graph: Graph, targetId: string, portKey: string): Graph {
  const edge = (graph.edges || []).find((e) => e.target === targetId && e.targetPort === portKey);
  if (!edge) return graph;
  const target = graph.nodes.find((n) => n.id === targetId);
  const cleared =
    target && nodeParam(target.type, portKey)
      ? disconnect(graph, targetId, portKey)
      : { ...graph, edges: graph.edges.filter((e) => e.id !== edge.id) };
  return connectLoose(cleared, edge.source, targetId);
}
