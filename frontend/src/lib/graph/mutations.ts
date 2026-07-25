// Graph mutation helpers. All immutably return a new Graph and keep the
// binding<->edge invariant (01 §3.3): wiring a value source writes BOTH the port
// binding and the edge; removing a node resets any binding that pointed at it.

import {
  LOOSE_PORT,
  isLooseEdge,
  mkEdgeId,
  mkInputId,
  mkSlotId,
  portsOf,
  videoSource,
} from "./core";
import { combineSlot, imageNode, montageExtract, videoNode } from "./factories";
import { nodeParam } from "../nodeParams";
import type { Binding, CombineMedium, CombineNode, Graph, GraphNode, MontageNode } from "../types";

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

// Rename a card (node-level `name`). A blank/whitespace name clears back to the
// lazy "<type> N" fallback. Node-level, so it never touches outputHash → no re-render.
export function renameNode(graph: Graph, id: string, name: string): Graph {
  const trimmed = name.trim();
  return {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.id === id ? ({ ...n, name: trimmed || undefined } as GraphNode) : n
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

// Montage extracts & breakpoints. Extracts are DATA references into the composition
// pool — no wiring — so none of these touch edges; removing an extract never deletes
// the composition it references (pool lifecycle is the prune step's job). Breakpoint
// times are composition-LOCAL seconds (0 = window start).
const patchMontage = (
  graph: Graph,
  montageId: string,
  fn: (d: MontageNode["data"]) => MontageNode["data"]
): Graph => ({
  ...graph,
  nodes: graph.nodes.map((n) =>
    n.id === montageId && n.type === "montage" ? { ...n, data: fn(n.data) } : n
  ),
});

export function addExtract(graph: Graph, montageId: string, compositionId: string): Graph {
  return patchMontage(graph, montageId, (d) => ({
    ...d,
    extracts: [...d.extracts, montageExtract(compositionId)],
  }));
}

export function removeExtract(graph: Graph, montageId: string, extractId: string): Graph {
  return patchMontage(graph, montageId, (d) => ({
    ...d,
    extracts: d.extracts.filter((x) => x.id !== extractId),
  }));
}

// Reorder an extract to `toIndex` (clamped) — the strip's drag-reorder.
export function moveExtract(
  graph: Graph,
  montageId: string,
  extractId: string,
  toIndex: number
): Graph {
  return patchMontage(graph, montageId, (d) => {
    const from = d.extracts.findIndex((x) => x.id === extractId);
    if (from < 0) return d;
    const to = Math.max(0, Math.min(d.extracts.length - 1, Math.round(toIndex)));
    if (to === from) return d;
    const extracts = [...d.extracts];
    const [x] = extracts.splice(from, 1);
    extracts.splice(to, 0, x);
    return { ...d, extracts };
  });
}

// Point an existing extract at another composition (the reuse picker).
export function setExtractComposition(
  graph: Graph,
  montageId: string,
  extractId: string,
  compositionId: string
): Graph {
  return patchMontage(graph, montageId, (d) => ({
    ...d,
    extracts: d.extracts.map((x) => (x.id === extractId ? { ...x, compositionId } : x)),
  }));
}

// An extract's span = how many effective cuts it swallows. Stored only when ≥ 2 —
// span 1 stays absent so an untouched extract keeps its exact persisted shape (and
// the output hash).
export function setExtractSpan(
  graph: Graph,
  montageId: string,
  extractId: string,
  span: number
): Graph {
  const clamped = Math.min(16, Math.max(1, Math.round(span)));
  return patchMontage(graph, montageId, (d) => ({
    ...d,
    extracts: d.extracts.map((x) => {
      if (x.id !== extractId) return x;
      const { span: _drop, ...rest } = x;
      return clamped >= 2 ? { ...rest, span: clamped } : rest;
    }),
  }));
}

// The in-point: seconds into the child's local clock at the cut (montage-resume's
// "align it" writes this). Stored only when > 0, same absent-default rule as span.
export function setExtractInPoint(
  graph: Graph,
  montageId: string,
  extractId: string,
  inPoint: number
): Graph {
  const t = Math.max(0, inPoint);
  return patchMontage(graph, montageId, (d) => ({
    ...d,
    extracts: d.extracts.map((x) => {
      if (x.id !== extractId) return x;
      const { inPoint: _drop, ...rest } = x;
      return t > 0 ? { ...rest, inPoint: t } : rest;
    }),
  }));
}

// Placing (or moving) a manual cut at `t` also CLEARS any `disabledCuts` entry within
// `tol` of it: a disabled entry silences EVERY cut source at that time (the render
// rule, _effective_cuts/montageCuts), so without the sweep a fresh "cut here" landing
// on an old "no cut here" would be silently ignored. The newest gesture wins.
export function addManualBreakpoint(
  graph: Graph,
  montageId: string,
  t: number,
  tol: number = 0
): Graph {
  if (!(t > 0)) return graph;
  return patchMontage(graph, montageId, (d) => ({
    ...d,
    manualBreakpoints: [...d.manualBreakpoints, { id: mkSlotId(), t }].sort((a, b) => a.t - b.t),
    disabledCuts: d.disabledCuts.filter((x) => Math.abs(x - t) > tol),
  }));
}

export function moveManualBreakpoint(
  graph: Graph,
  montageId: string,
  breakpointId: string,
  t: number,
  tol: number = 0
): Graph {
  if (!(t > 0)) return graph;
  return patchMontage(graph, montageId, (d) => ({
    ...d,
    manualBreakpoints: d.manualBreakpoints
      .map((bp) => (bp.id === breakpointId ? { ...bp, t } : bp))
      .sort((a, b) => a.t - b.t),
    disabledCuts: d.disabledCuts.filter((x) => Math.abs(x - t) > tol),
  }));
}

export function removeManualBreakpoint(
  graph: Graph,
  montageId: string,
  breakpointId: string
): Graph {
  return patchMontage(graph, montageId, (d) => ({
    ...d,
    manualBreakpoints: d.manualBreakpoints.filter((bp) => bp.id !== breakpointId),
  }));
}

// Toggle one GATE cut on/off: clicking a gate marker stores/clears a `disabledCuts`
// exception at that time. Matching is by tolerance (the caller passes half a frame,
// 0.5/fps — the same rule the render applies), so toggling twice round-trips even if
// the stored second differs by float noise, and a cut that MOVED re-enables itself.
// DISABLING also deletes any manual breakpoint within the tolerance: the click says
// "no cut at this time", and a manual left on the same frame would keep cutting
// (a disabled entry silences it too, but sweeping keeps the data honest — no
// invisible breakpoint parked under a greyed gate mark).
export function toggleAutoCut(graph: Graph, montageId: string, t: number, tol: number): Graph {
  return patchMontage(graph, montageId, (d) => {
    const kept = d.disabledCuts.filter((x) => Math.abs(x - t) > tol);
    const disabling = kept.length === d.disabledCuts.length;
    return {
      ...d,
      disabledCuts: disabling ? [...d.disabledCuts, t].sort((a, b) => a - b) : kept,
      manualBreakpoints: disabling
        ? d.manualBreakpoints.filter((bp) => Math.abs(bp.t - t) > tol)
        : d.manualBreakpoints,
    };
  });
}

// Drop a library asset onto the canvas as its own card (image or video, per `kind`),
// already pointing at the file. New cards stack in a COLUMN under the existing graph:
// picking twenty clips for a montage should never pile them on top of each other, and a
// predictable column is easy to re-arrange afterwards.
export function addAssetCard(
  graph: Graph,
  asset: { url: string; kind: "image" | "video" },
  name?: string
): Graph {
  const nodes = graph.nodes || [];
  const x = nodes.length ? Math.min(...nodes.map((n) => n.x)) : 80;
  const y = nodes.length ? Math.max(...nodes.map((n) => n.y)) + 140 : 80;
  const node = asset.kind === "video" ? videoNode(x, y) : imageNode(x, y);
  (node.data as { assetUrl: string }).assetUrl = asset.url;
  // `name` is applied HERE rather than by the caller re-walking the result. Studio used
  // to call this, then map over every node renaming `graph.nodes[graph.nodes.length - 1]`
  // — an unwritten "the card I added is last" contract with the one function allowed to
  // decide where it goes. Naming it at the point of creation removes the guess.
  return { ...graph, nodes: [...nodes, name ? { ...node, name } : node] };
}

// ---- wiring (keeps the §3.3 binding<->edge invariant) ------------------------

// Clone-write one port's binding on the target node — connect/disconnect MUST NOT
// mutate the previous graph in place (undo/history and memo comparisons depend on
// the old snapshot staying intact; fluidBindings.patchBinding sets the precedent).
function withBinding(graph: Graph, targetId: string, paramKey: string, binding: Binding): Graph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (n.id !== targetId) return n;
      const ports = portsOf(n);
      if (!ports) return n;
      return {
        ...n,
        data: { ...n.data, ports: { ...ports, [paramKey]: { binding } } },
      } as GraphNode;
    }),
  };
}

// Wire a value-source node into a modulatable param (fluid or an FX card): writes
// BOTH the binding and the edge. lo/hi default to the param range (maps source
// 0..1 -> native units).
export function connect(graph: Graph, sourceId: string, targetId: string, paramKey: string): Graph {
  const node = graph.nodes.find((n) => n.id === targetId);
  const p = node ? nodeParam(node.type, paramKey) : undefined;
  if (!p || !node || !portsOf(node)) return graph;
  const g2 = withBinding(graph, targetId, paramKey, {
    kind: "node",
    nodeId: sourceId,
    lo: p.min,
    hi: p.max,
  });
  const edges = g2.edges.filter((e) => !(e.target === targetId && e.targetPort === paramKey));
  edges.push({
    id: mkEdgeId(),
    source: sourceId,
    sourcePort: "out",
    target: targetId,
    targetPort: paramKey,
  });
  return { ...g2, edges };
}

// Clear a wired param back to its default constant, dropping the edge.
export function disconnect(graph: Graph, targetId: string, paramKey: string): Graph {
  const node = graph.nodes.find((n) => n.id === targetId);
  const p = node ? nodeParam(node.type, paramKey) : undefined;
  if (!p || !node || !portsOf(node)) return graph;
  const g2 = withBinding(graph, targetId, paramKey, { kind: "const", value: p.def });
  return {
    ...g2,
    edges: g2.edges.filter((e) => !(e.target === targetId && e.targetPort === paramKey)),
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
          ports[key] = {
            ...port,
            binding: { kind: "const", value: nodeParam(n.type, key)?.def ?? 0 },
          };
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
  // Drop the removed node from the legacy expand/minimize sets, in case a save is
  // mutated before normalizeGraph strips them. (viewOverrides is gone as of v29.)
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
export function resolveDropPort(graph: Graph, targetId: string, flow: string): string | null {
  const node = graph.nodes.find((n) => n.id === targetId);
  if (!node) return null;
  if (flow === "video") {
    if (node.type === "output") return videoSource(graph, targetId, "video") ? null : "video";
    if (node.type === "combine") {
      const free = node.data.inputs.find((s) => !videoSource(graph, targetId, s.id));
      return free ? free.id : null;
    }
    // montage: extracts are DATA references, not wired slots — a dropped video wire
    // has nowhere to land (its only inbound wiring is the value ports).
    // waves/rain refract an optional video input (the pool floor / liquid bed).
    if (node.type === "waves" || node.type === "rain")
      return videoSource(graph, targetId, "video") ? null : "video";
    return null;
  }
  if (flow === "images") {
    return node.type === "slideshow" && !videoSource(graph, targetId, "images") ? "images" : null;
  }
  if (flow === "points") {
    // fluid emitters and the gen-sim cards with multiple origins (fire flames,
    // lightning strike points, rain drip points) all take a points card.
    const takesPoints =
      node.type === "fluid" ||
      node.type === "fire" ||
      node.type === "lightning" ||
      node.type === "rain";
    return takesPoints && !videoSource(graph, targetId, "positions") ? "positions" : null;
  }
  if (flow === "color") {
    const GEN_TYPES = ["waves", "lightning", "fire", "aurora", "rain", "clouds"];
    const candidates =
      node.type === "lyrics"
        ? ["fillColor", "outlineColor"]
        : node.type === "fluid" || GEN_TYPES.includes(node.type)
          ? ["color"]
          : node.type === "colorgrade"
            ? ["tint"]
            : [];
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
      {
        id: mkEdgeId(),
        source: sourceId,
        sourcePort: "out",
        target: targetId,
        targetPort: LOOSE_PORT,
      },
    ],
  };
}

// Land a source on a target PORT, dispatching on what the port is: a modulatable
// param goes through `connect` (binding + edge written together — §3.3), anything
// else (video/positions/color/layer slots) is a plain typed edge. Any wire the same
// source had PARKED on this card is consumed by the assignment, so promoting a
// parked wire and dropping a fresh one converge on the same graph.
//
// The single place that decision is made: `assignEdge` (the picker's dropdown) and
// the canvas drop menu both route here, so the two entry points can't drift.
export function wirePort(
  graph: Graph,
  sourceId: string,
  sourcePort: string,
  targetId: string,
  portKey: string
): Graph {
  const g = {
    ...graph,
    edges: (graph.edges || []).filter(
      (e) => !(e.source === sourceId && e.target === targetId && isLooseEdge(e))
    ),
  };
  const target = g.nodes.find((n) => n.id === targetId);
  if (target && nodeParam(target.type, portKey)) {
    return connect(g, sourceId, targetId, portKey);
  }
  return connectVideo(g, sourceId, sourcePort, targetId, portKey);
}

// Promote a loose edge onto a real port. The loose edge is dropped either way
// (connect/connectVideo replace any existing edge into that port).
export function assignEdge(graph: Graph, edgeId: string, portKey: string): Graph {
  const edge = (graph.edges || []).find((e) => e.id === edgeId);
  if (!edge || !isLooseEdge(edge)) return graph;
  return wirePort(graph, edge.source, edge.sourcePort, edge.target, portKey);
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
