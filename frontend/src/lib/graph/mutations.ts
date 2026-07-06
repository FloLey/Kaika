// Graph mutation helpers. All immutably return a new Graph and keep the
// binding<->edge invariant (01 §3.3): wiring a value source writes BOTH the port
// binding and the edge; removing a node resets any binding that pointed at it.

import { mkEdgeId, mkInputId, portsOf } from "./core";
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
