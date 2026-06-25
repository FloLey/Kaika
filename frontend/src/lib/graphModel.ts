// The graph data model (01 §3.1–3.7). Framework-free: node/edge factories,
// mutation helpers that keep the binding<->edge invariant (§3.3), validation (§3.7)
// and a stable hash for the render cache (§3.6). Node `data` is the discriminated
// union from types.ts, so per-type access is checked after narrowing on `type`.

import { FLUID_PARAMS as RAW_FLUID_PARAMS, FLUID_PARAM_KEYS, fluidParam as rawFluidParam } from "./fluidParams.js";
import type {
  Binding, Graph, GraphEdge, GraphNode, CombineSlot, CombineMedium, FluidNode,
  PointsNode, CombineNode, OutputNode, SignalNode, ValidationResult,
} from "./types";

// fluidParams.js is untyped JS; pin the shapes graphModel relies on.
const FLUID_PARAMS = RAW_FLUID_PARAMS as { key: string; def: number; min: number; max: number }[];
const fluidParam = rawFluidParam as (k: string) => { def: number; min: number; max: number };

// Same id convention as segments.js `rid`: "<prefix>-<8 chars>".
const rid = (p: string): string => {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return `${p}-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${p}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
};

export const mkNodeId = (): string => rid("n");
export const mkEdgeId = (): string => rid("e");

// ---- node factories (01 §3.1) ------------------------------------------------

export function signalNode(signal: { id: string; name?: string }, x: number, y: number): SignalNode {
  return {
    id: mkNodeId(), type: "signal", x, y,
    data: { signalId: signal.id, label: signal.name },
  };
}

export function outputNode(x: number, y: number): OutputNode {
  return { id: mkNodeId(), type: "output", x, y, data: { title: "preview" } };
}

export function fluidNode(x: number, y: number): FluidNode {
  const ports: Record<string, { binding: Binding }> = {};
  for (const p of FLUID_PARAMS) ports[p.key] = { binding: { kind: "const", value: p.def } };
  return {
    id: mkNodeId(), type: "fluid", x, y,
    data: {
      // No `duration`: the clip always spans the full segment (set by the executor).
      static: {
        grid: 96, fps: 24, color: [0.27, 0.69, 1], intensity: 1, opacity: 1,
        enabled: true, radial: false, wrap: true, points: [[0.5, 0.5]], path_speed: 1,
        path_closed: false, path_pingpong: false,
      },
      ports,
    },
  };
}

// The current persisted graph schema version. Bump when the saved graph shape
// changes; normalizeGraph() upgrades any older save to here and re-stamps it.
//   v1: signal/fluid/output node-graph.
//   v2: + combine + points nodes, the fluid `positions` input, minimize set.
export const GRAPH_VERSION = 2;

export function emptyGraph(): Graph {
  return { version: GRAPH_VERSION, nodes: [], edges: [], view: { tx: 0, ty: 0, scale: 1 } };
}

// ---- combine node (spec 10) --------------------------------------------------
// Composes N video inputs into one. mode "merge" = the inputs' emitters share ONE
// simulation (using THIS card's medium); "stack" = render each input and alpha-over
// them in input order (index 0 = top) with per-input opacity. Inputs are ordered
// slots; a video edge targets a slot by its id (targetPort).
const mkSlotId = (): string => rid("slot");
export const combineSlot = (opacity = 1): CombineSlot => ({ id: mkSlotId(), opacity });
const COMBINE_MEDIUM: CombineMedium = { dissipation: 0.95, velocity_dissipation: 0.97, viscosity: 0.0, vorticity: 6.0 };

export function combineNode(x: number, y: number): CombineNode {
  return {
    id: mkNodeId(), type: "combine", x, y,
    data: { mode: "merge", inputs: [combineSlot(), combineSlot()], medium: { ...COMBINE_MEDIUM } },
  };
}

// ---- points node (spec 11) ---------------------------------------------------
// A drawn set of source positions (normalised 0..1). Wired into a fluid's
// `positions` input, the fluid emits one source per point (sharing its params).
// Output port flow is "points". Seeded with one centre point.
export function pointsNode(x: number, y: number): PointsNode {
  return { id: mkNodeId(), type: "points", x, y, data: { points: [[0.5, 0.5]] } };
}

type Point = [number, number];
const patchPoints = (graph: Graph, id: string, fn: (pts: Point[]) => Point[]): Graph => ({
  ...graph,
  nodes: graph.nodes.map((n) =>
    n.id === id && n.type === "points"
      ? { ...n, data: { ...n.data, points: fn(n.data.points || []) } }
      : n),
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

export const VIDEO_PRODUCERS = new Set<string>(["fluid", "combine", "output"]);

// The node wired into (targetId, targetPort) via a video edge, or null.
export function videoSource(graph: Graph, targetId: string, targetPort: string): string | null {
  const e = (graph.edges || []).find((x) => x.target === targetId && x.targetPort === targetPort);
  return e ? e.source : null;
}

// Wire a video producer into a target port (output "video" or a combine slot id);
// last-wins (replaces any existing edge into that port).
export function connectVideo(graph: Graph, sourceId: string, sourcePort: string, targetId: string, targetPort: string): Graph {
  const edges = (graph.edges || []).filter((e) => !(e.target === targetId && e.targetPort === targetPort));
  edges.push({ id: mkEdgeId(), source: sourceId, sourcePort, target: targetId, targetPort });
  return { ...graph, edges };
}

const patchCombine = (graph: Graph, combineId: string, fn: (d: CombineNode["data"]) => CombineNode["data"]): Graph => ({
  ...graph,
  nodes: graph.nodes.map((n) =>
    n.id === combineId && n.type === "combine" ? { ...n, data: fn(n.data) } : n),
});

export function addCombineInput(graph: Graph, combineId: string): Graph {
  return patchCombine(graph, combineId, (d) => ({ ...d, inputs: [...d.inputs, combineSlot()] }));
}
export function removeCombineInput(graph: Graph, combineId: string, slotId: string): Graph {
  const g = patchCombine(graph, combineId, (d) => ({ ...d, inputs: d.inputs.filter((s) => s.id !== slotId) }));
  return { ...g, edges: g.edges.filter((e) => !(e.target === combineId && e.targetPort === slotId)) };
}
export function setCombineMode(graph: Graph, combineId: string, mode: "merge" | "stack"): Graph {
  return patchCombine(graph, combineId, (d) => ({ ...d, mode }));
}
export function setCombineOpacity(graph: Graph, combineId: string, slotId: string, opacity: number): Graph {
  return patchCombine(graph, combineId, (d) => ({
    ...d, inputs: d.inputs.map((s) => (s.id === slotId ? { ...s, opacity } : s)),
  }));
}
export function setCombineMedium(graph: Graph, combineId: string, key: keyof CombineMedium, value: number): Graph {
  return patchCombine(graph, combineId, (d) => ({ ...d, medium: { ...d.medium, [key]: value } }));
}

// Whether `nodeId` resolves to fluid emitter(s) for a merge (no stack upstream).
function isEmitterSource(graph: Graph, nodeId: string, byId: Map<string, GraphNode>, seen = new Set<string>()): boolean {
  if (seen.has(nodeId)) return false;
  seen.add(nodeId);
  const node = byId.get(nodeId);
  if (!node) return false;
  if (node.type === "fluid") return true;
  if (node.type === "output") {
    const src = videoSource(graph, nodeId, "video");
    return src != null && isEmitterSource(graph, src, byId, seen);
  }
  if (node.type === "combine") {
    if (node.data.mode === "stack") return false;
    for (const slot of node.data.inputs || []) {
      const src = videoSource(graph, nodeId, slot.id);
      if (src != null && !isEmitterSource(graph, src, byId, seen)) return false;
    }
    return true;
  }
  return false;
}

// Upgrade a (possibly older) persisted graph to the current GRAPH_VERSION. Every
// fluid node is coerced to EXACTLY the current FLUID_PARAMS ports (a param added
// since the save gets a default port; a removed one + its dangling edges are
// dropped), combine/points get any missing fields, and the result is re-stamped to
// GRAPH_VERSION. Idempotent + returns the same object when nothing changed (safe to
// run on every load). For a future breaking change, add a targeted step keyed on the
// incoming version before the shape pass, then bump GRAPH_VERSION.
export function normalizeGraph(graph: Graph): Graph {
  if (!graph || !Array.isArray(graph.nodes)) return graph;
  let changed = false;
  const nodes = graph.nodes.map((n): GraphNode => {
    if (n.type === "points") {
      const pts = Array.isArray(n.data?.points) ? n.data.points : ([[0.5, 0.5]] as Point[]);
      if (pts !== n.data?.points) changed = true;
      return { ...n, data: { ...n.data, points: pts } };
    }
    if (n.type === "combine") {
      // Ensure a combine carries mode / inputs / medium (older/partial saves).
      const d = (n.data || {}) as Partial<CombineNode["data"]>;
      const inputs: CombineSlot[] = Array.isArray(d.inputs) && d.inputs.length
        ? d.inputs.map((s) => ({ id: s.id || mkSlotId(), opacity: s.opacity ?? 1 }))
        : [combineSlot(), combineSlot()];
      const data: CombineNode["data"] = {
        mode: d.mode || "merge", inputs, medium: { ...COMBINE_MEDIUM, ...(d.medium || {}) },
      };
      if (JSON.stringify(data) !== JSON.stringify(d)) changed = true;
      return { ...n, data };
    }
    if (n.type !== "fluid") return n;
    const old = n.data?.ports || {};
    const ports: Record<string, { binding: Binding }> = {};
    for (const p of FLUID_PARAMS) {
      ports[p.key] = old[p.key] || { binding: { kind: "const", value: p.def } };
    }
    const sameKeys =
      Object.keys(old).length === FLUID_PARAMS.length &&
      FLUID_PARAMS.every((p) => old[p.key]);
    if (!sameKeys) changed = true;
    return { ...n, data: { ...n.data, ports } };
  });
  // Drop edges that targeted a now-removed fluid PARAM port (keeps the §3.3
  // invariant). `positions` (the points input, spec 11) is a non-param fluid input,
  // so it's allowed — don't drop it.
  const valid = new Set([...FLUID_PARAM_KEYS, "positions"]);
  const fluidIds = new Set(nodes.filter((n) => n.type === "fluid").map((n) => n.id));
  const edges = (graph.edges || []).filter(
    (e) => !(fluidIds.has(e.target) && !valid.has(e.targetPort))
  );
  if (edges.length !== (graph.edges || []).length) changed = true;
  if (graph.version !== GRAPH_VERSION) changed = true;   // re-stamp after migrating
  return changed ? { ...graph, version: GRAPH_VERSION, nodes, edges } : graph;
}

// ---- wiring (keeps the §3.3 binding<->edge invariant) ------------------------

// Wire a value-source node into a fluid param: writes BOTH the binding and the
// edge. lo/hi default to the param range (maps source 0..1 -> native units).
export function connect(graph: Graph, sourceId: string, fluidId: string, paramKey: string): Graph {
  const p = fluidParam(paramKey);
  const fluid = graph.nodes.find((n) => n.id === fluidId);
  if (!fluid || fluid.type !== "fluid") return graph;
  fluid.data.ports[paramKey] = { binding: { kind: "node", nodeId: sourceId, lo: p.min, hi: p.max } };
  const edges = graph.edges.filter((e) => !(e.target === fluidId && e.targetPort === paramKey));
  edges.push({ id: mkEdgeId(), source: sourceId, sourcePort: "out", target: fluidId, targetPort: paramKey });
  return { ...graph, edges };
}

// Clear a wired param back to its default constant, dropping the edge.
export function disconnect(graph: Graph, fluidId: string, paramKey: string): Graph {
  const p = fluidParam(paramKey);
  const fluid = graph.nodes.find((n) => n.id === fluidId);
  if (!fluid || fluid.type !== "fluid") return graph;
  fluid.data.ports[paramKey] = { binding: { kind: "const", value: p.def } };
  return { ...graph, edges: graph.edges.filter((e) => !(e.target === fluidId && e.targetPort === paramKey)) };
}

// Drop a node, its incident edges, and reset any fluid port bound to it back to
// the param default constant (so no binding dangles — §3.3 invariant).
export function removeNode(graph: Graph, nodeId: string): Graph {
  const nodes = graph.nodes
    .filter((n) => n.id !== nodeId)
    .map((n): GraphNode => {
      if (n.type !== "fluid") return n;
      let touched = false;
      const ports: Record<string, { binding: Binding }> = {};
      for (const [key, port] of Object.entries(n.data.ports)) {
        const b = port.binding;
        if (b && b.kind === "node" && b.nodeId === nodeId) {
          ports[key] = { ...port, binding: { kind: "const", value: fluidParam(key).def } };
          touched = true;
        } else {
          ports[key] = port;
        }
      }
      if (!touched) return n;
      return { ...n, data: { ...n.data, ports } };
    });
  const edges = graph.edges.filter((e) => e.source !== nodeId && e.target !== nodeId);
  const out: Graph = { ...graph, nodes, edges };
  // Drop the removed node from the persisted minimize set (no stale ids).
  if (Array.isArray(graph.minimized) && graph.minimized.includes(nodeId)) {
    out.minimized = graph.minimized.filter((id) => id !== nodeId);
  }
  return out;
}

// ---- validation (01 §3.7) ----------------------------------------------------

// The video producer feeding `outputId` via its single `video` in-edge, or null
// (mirrors backend validate). A producer is a fluid, combine, or output-passthrough.
export function videoInput(graph: Graph, outputId: string): GraphNode | null {
  const incoming = (graph.edges || []).filter((e) => e.target === outputId && e.targetPort === "video");
  if (incoming.length !== 1) return null;
  const src = (graph.nodes || []).find((n) => n.id === incoming[0].source);
  return src && VIDEO_PRODUCERS.has(src.type) ? src : null;
}

export const outputNodes = (graph: Graph): OutputNode[] =>
  (graph.nodes || []).filter((n): n is OutputNode => n.type === "output");

// All node ids upstream of `outputId` — a backward walk over every edge (video DAG
// + value bindings). Mirrors backend `_contributing_ids`.
function outputContributing(graph: Graph, outputId: string): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const e of graph.edges || []) {
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target)!.push(e.source);
  }
  const seen = new Set<string>();
  const stack = [outputId];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const s of incoming.get(id) || []) stack.push(s);
  }
  return seen;
}

// Whether one output is renderable: a video producer feeds it AND its whole
// contributing video DAG is complete (fluid bindings resolve, each combine has a
// wired input, merges are emitter-resolvable, passthrough outputs have an input).
export function outputRenderable(graph: Graph, outputId: string): boolean {
  if (!videoInput(graph, outputId)) return false;
  const byId = new Map<string, GraphNode>((graph.nodes || []).map((n) => [n.id, n]));
  for (const nid of outputContributing(graph, outputId)) {
    const n = byId.get(nid);
    if (!n) continue;
    if (n.type === "fluid") {
      for (const port of Object.values(n.data.ports || {})) {
        const b = port.binding;
        if (b && b.kind === "node" && !byId.has(b.nodeId)) return false;
      }
    } else if (n.type === "combine") {
      const wired = (n.data.inputs || []).some((s) => videoSource(graph, nid, s.id) != null);
      if (!wired) return false;
      if (n.data.mode === "merge") {
        for (const slot of n.data.inputs || []) {
          const src = videoSource(graph, nid, slot.id);
          if (src != null && !isEmitterSource(graph, src, byId)) return false;
        }
      }
    } else if (n.type === "output" && nid !== outputId) {
      if (videoSource(graph, nid, "video") == null) return false;
    }
  }
  return true;
}

export function validate(graph: Graph): ValidationResult {
  if (!graph || !Array.isArray(graph.nodes)) return { ok: false, error: "no graph" };
  const nodes = graph.nodes;
  const byId = new Map<string, GraphNode>(nodes.map((n) => [n.id, n]));

  // 1. at least one output; each wired to exactly one video producer (fluid /
  //    combine / output-passthrough). N independent pipelines are allowed.
  const outputs = nodes.filter((n) => n.type === "output");
  if (outputs.length < 1) return { ok: false, error: "graph needs at least one output node" };
  for (const out of outputs) {
    if (!videoInput(graph, out.id)) {
      return { ok: false, error: "an output is not wired to exactly one source" };
    }
  }

  // 2. every fluid port binding is well-formed (const numeric / node resolves to an
  //    existing node with numeric lo/hi). Mirrors backend graph._validate_binding.
  for (const n of nodes.filter((x): x is FluidNode => x.type === "fluid")) {
    for (const [key, port] of Object.entries(n.data.ports || {})) {
      // Loosen the type: validate is the boundary that catches malformed runtime data.
      const b = port.binding as
        | { kind?: string; value?: unknown; nodeId?: string; lo?: unknown; hi?: unknown }
        | undefined;
      if (!b || !b.kind) continue;   // unbound port -> param default
      if (b.kind === "const") {
        if (typeof b.value !== "number") return { ok: false, error: `port "${key}" const binding is not numeric` };
      } else if (b.kind === "node") {
        if (!b.nodeId || !byId.has(b.nodeId)) return { ok: false, error: `port "${key}" is bound to a missing node` };
        if (typeof b.lo !== "number" || typeof b.hi !== "number") {
          return { ok: false, error: `port "${key}" node binding lo/hi is not numeric` };
        }
      } else {
        return { ok: false, error: `port "${key}" has an unknown binding kind` };
      }
    }
  }

  // 2b. a merge combine's inputs must resolve to fluid emitters (no stack upstream).
  for (const cb of nodes.filter((x): x is CombineNode => x.type === "combine")) {
    if (cb.data.mode === "merge") {
      for (const slot of cb.data.inputs || []) {
        const src = videoSource(graph, cb.id, slot.id);
        if (src != null && !isEmitterSource(graph, src, byId)) {
          return { ok: false, error: "a layered (stack) combine can't feed a merge combine" };
        }
      }
    }
  }

  // 3. no cycles (still assert acyclic for forward-compat).
  if (hasCycle(nodes, graph.edges || [])) return { ok: false, error: "graph has a cycle" };

  return { ok: true };
}

function hasCycle(nodes: GraphNode[], edges: GraphEdge[]): boolean {
  const adj = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (adj.has(e.source)) adj.get(e.source)!.push(e.target);
  }
  const state = new Map<string, 0 | 1>(); // 0 = visiting, 1 = done
  const visit = (id: string): boolean => {
    if (state.get(id) === 1) return false;
    if (state.get(id) === 0) return true; // back-edge
    state.set(id, 0);
    for (const next of adj.get(id) || []) {
      if (visit(next)) return true;
    }
    state.set(id, 1);
    return false;
  };
  for (const n of nodes) {
    if (visit(n.id)) return true;
  }
  return false;
}

// ---- hashing (01 §3.6) -------------------------------------------------------

// Defining fields of a referenced signal that change the render output.
const SIGNAL_HASH_FIELDS = [
  "stemKey", "minHz", "maxHz", "feature", "attack",
  "release", "invert", "gamma", "gain", "offset", "threshold",
];

// Stable JSON: sorted keys, recursive. Callers hand it an already-canonicalized
// object (no x/y/view).
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

// FNV-1a over a string -> 8-hex. Only needs to match itself between renders (the
// backend computes the authoritative filename hash); this gates redundant POSTs.
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// Per-output subgraph hash: gates redundant POSTs for ONE output. Covers the WHOLE
// contributing video DAG upstream of `outputId` (fluids, combines, output
// pass-throughs, value/signal nodes) + the edges among them + bounds + jobId. So
// editing pipeline B never busts A's cache; moving a node / unrelated signal is a
// no-op. Mirrors backend `output_hash`.
export function outputHash(
  graph: Graph, outputId: string, jobId: string | null | undefined,
  start: number | null | undefined, end: number | null | undefined,
  signals: { id: string; [k: string]: unknown }[] | undefined,
): string {
  const contributing = outputContributing(graph, outputId);
  const sigById = new Map((signals || []).map((s) => [s.id, s]));
  const referenced: Record<string, unknown> = {};
  const nodes = (graph.nodes || [])
    .filter((n) => contributing.has(n.id))
    .map((n) => {
      if (n.type === "signal") {
        const sig = sigById.get(n.data.signalId);
        if (sig) {
          referenced[n.data.signalId] = Object.fromEntries(
            SIGNAL_HASH_FIELDS.map((k) => [k, sig[k]])
          );
        }
      }
      return { id: n.id, type: n.type, data: n.data };
    });
  const canon = {
    outputId,
    nodes,
    edges: (graph.edges || [])
      .filter((e) => contributing.has(e.source) && contributing.has(e.target))
      .map((e) => ({
        source: e.source, sourcePort: e.sourcePort, target: e.target, targetPort: e.targetPort,
      })),
    jobId: jobId ?? null,
    start: start ?? null,
    end: end ?? null,
    signals: referenced,
  };
  return fnv1a(stableStringify(canon));
}
