// The graph data model (01 §3.1–3.7). Pure JS, framework-free: node/edge
// factories, mutation helpers that keep the binding<->edge invariant (§3.3),
// validation (§3.7) and a stable hash for the render cache (§3.6). 05–07 consume
// this. Resolution stays generic (a binding -> a source node) so a future
// `combine` node type slots in as just another `nodeId`.

import { FLUID_PARAMS, FLUID_PARAM_KEYS, fluidParam } from "./fluidParams.js";

// Same id convention as segments.js `rid`: "<prefix>-<8 chars>".
const rid = (p) => {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return `${p}-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${p}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
};

export const mkNodeId = () => rid("n");
export const mkEdgeId = () => rid("e");

// ---- node factories (01 §3.1) ------------------------------------------------

export function signalNode(signal, x, y) {
  return {
    id: mkNodeId(), type: "signal", x, y,
    data: { signalId: signal.id, label: signal.name },
  };
}

export function constantNode(x, y, value = 0.5) {
  return { id: mkNodeId(), type: "constant", x, y, data: { value, label: "const" } };
}

export function outputNode(x, y) {
  return { id: mkNodeId(), type: "output", x, y, data: { title: "preview" } };
}

export function fluidNode(x, y) {
  const ports = {};
  for (const p of FLUID_PARAMS) ports[p.key] = { binding: { kind: "const", value: p.def } };
  return {
    id: mkNodeId(), type: "fluid", x, y,
    data: {
      // No `duration`: the clip always spans the full segment (set by the executor).
      static: {
        grid: 96, fps: 24, color: [0.27, 0.69, 1], intensity: 1, opacity: 1,
        enabled: true, radial: false, points: [[0.5, 0.5]], path_speed: 1,
        path_closed: false, path_pingpong: false,
      },
      ports,
    },
  };
}

export function emptyGraph() {
  return { version: 1, nodes: [], edges: [], view: { tx: 0, ty: 0, scale: 1 } };
}

// Migrate a (possibly older) persisted graph so every fluid node exposes EXACTLY
// the current FLUID_PARAMS ports. A graph saved before a param existed (e.g. the
// r/g/b colour ports) has no port for it, so `connect()`/`disconnect()` — which
// write `ports[key].binding` — would throw on undefined and the wire would
// silently fail. Conversely, params since removed (rot_speed/rot_accel) get their
// stale ports and any dangling edges dropped. Returns the same object when nothing
// changed, so it's safe to run on every load (idempotent, memo-stable).
export function normalizeGraph(graph) {
  if (!graph || !Array.isArray(graph.nodes)) return graph;
  let changed = false;
  const nodes = graph.nodes.map((n) => {
    if (n.type !== "fluid") return n;
    const old = n.data?.ports || {};
    const ports = {};
    for (const p of FLUID_PARAMS) {
      ports[p.key] = old[p.key] || { binding: { kind: "const", value: p.def } };
    }
    const sameKeys =
      Object.keys(old).length === FLUID_PARAMS.length &&
      FLUID_PARAMS.every((p) => old[p.key]);
    if (!sameKeys) changed = true;
    return { ...n, data: { ...n.data, ports } };
  });
  // Drop edges that targeted a now-removed fluid param (keeps the §3.3 invariant).
  const valid = new Set(FLUID_PARAM_KEYS);
  const fluidIds = new Set(nodes.filter((n) => n.type === "fluid").map((n) => n.id));
  const edges = (graph.edges || []).filter(
    (e) => !(fluidIds.has(e.target) && !valid.has(e.targetPort))
  );
  if (edges.length !== (graph.edges || []).length) changed = true;
  return changed ? { ...graph, nodes, edges } : graph;
}

// ---- wiring (keeps the §3.3 binding<->edge invariant) ------------------------

// Wire a value-source node into a fluid param: writes BOTH the binding and the
// edge. lo/hi default to the param range (maps source 0..1 -> native units).
export function connect(graph, sourceId, fluidId, paramKey) {
  const p = fluidParam(paramKey);
  const fluid = graph.nodes.find((n) => n.id === fluidId);
  if (!fluid.data.ports[paramKey]) fluid.data.ports[paramKey] = {};
  fluid.data.ports[paramKey].binding = { kind: "node", nodeId: sourceId, lo: p.min, hi: p.max };
  const edges = graph.edges.filter((e) => !(e.target === fluidId && e.targetPort === paramKey));
  edges.push({ id: mkEdgeId(), source: sourceId, sourcePort: "out", target: fluidId, targetPort: paramKey });
  return { ...graph, edges };
}

// Clear a wired param back to its default constant, dropping the edge.
export function disconnect(graph, fluidId, paramKey) {
  const p = fluidParam(paramKey);
  const fluid = graph.nodes.find((n) => n.id === fluidId);
  if (!fluid.data.ports[paramKey]) fluid.data.ports[paramKey] = {};
  fluid.data.ports[paramKey].binding = { kind: "const", value: p.def };
  return { ...graph, edges: graph.edges.filter((e) => !(e.target === fluidId && e.targetPort === paramKey)) };
}

// Drop a node, its incident edges, and reset any fluid port bound to it back to
// the param default constant (so no binding dangles — §3.3 invariant).
export function removeNode(graph, nodeId) {
  const nodes = graph.nodes
    .filter((n) => n.id !== nodeId)
    .map((n) => {
      if (n.type !== "fluid") return n;
      let touched = false;
      const ports = {};
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
  return { ...graph, nodes, edges };
}

// Patch a wired port's lo/hi mapping (no-op if the port isn't node-bound).
export function setPortRange(graph, fluidId, paramKey, lo, hi) {
  const nodes = graph.nodes.map((n) => {
    if (n.id !== fluidId) return n;
    const port = n.data.ports[paramKey];
    if (!port || !port.binding || port.binding.kind !== "node") return n;
    const ports = { ...n.data.ports, [paramKey]: { ...port, binding: { ...port.binding, lo, hi } } };
    return { ...n, data: { ...n.data, ports } };
  });
  return { ...graph, nodes };
}

// ---- validation (01 §3.7) ----------------------------------------------------

export function validate(graph) {
  if (!graph || !Array.isArray(graph.nodes)) return { ok: false, error: "no graph" };
  const nodes = graph.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // 1. exactly one output, exactly one fluid (v1).
  const outputs = nodes.filter((n) => n.type === "output");
  const fluids = nodes.filter((n) => n.type === "fluid");
  if (outputs.length !== 1) return { ok: false, error: "graph needs exactly one output node" };
  if (fluids.length !== 1) return { ok: false, error: "graph needs exactly one fluid node" };

  // 1 (cont). the fluid must be wired into the output via an edge.
  const fluid = fluids[0];
  const output = outputs[0];
  const wiredToOutput = (graph.edges || []).some(
    (e) => e.source === fluid.id && e.target === output.id
  );
  if (!wiredToOutput) return { ok: false, error: "fluid is not wired into the output" };

  // 2. every node-binding resolves to an existing node.
  for (const n of fluids) {
    for (const [key, port] of Object.entries(n.data.ports || {})) {
      const b = port.binding;
      if (b && b.kind === "node" && !byId.has(b.nodeId)) {
        return { ok: false, error: `port "${key}" is bound to a missing node` };
      }
    }
  }

  // 3. no cycles (v1 graphs are trees; still assert acyclic for forward-compat).
  if (hasCycle(nodes, graph.edges || [])) return { ok: false, error: "graph has a cycle" };

  return { ok: true };
}

function hasCycle(nodes, edges) {
  const adj = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (adj.has(e.source)) adj.get(e.source).push(e.target);
  }
  const state = new Map(); // 0 = visiting, 1 = done
  const visit = (id) => {
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

// Stable JSON: sorted keys, recursive. Excludes nothing on its own — callers
// hand it an already-canonicalized object (no x/y/view).
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

// FNV-1a over a string -> 8-hex. Only needs to match itself between renders (the
// backend computes the authoritative filename hash); this gates redundant POSTs.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// Stable hash over nodes (type + data, minus x/y/view), edges, the segment
// bounds + job id, and the defining fields of every signal referenced by a
// `signal` node. `signals` is the segment's signal list (for resolving refs).
export function graphHash(graph, jobId, start, end, signals) {
  const sigById = new Map((signals || []).map((s) => [s.id, s]));
  const referenced = {};
  const nodes = (graph.nodes || []).map((n) => {
    if (n.type === "signal") {
      const sig = sigById.get(n.data.signalId);
      if (sig) {
        referenced[n.data.signalId] = Object.fromEntries(
          SIGNAL_HASH_FIELDS.map((k) => [k, sig[k]])
        );
      }
    }
    // exclude x/y; keep id, type, data (data carries no transient view fields).
    return { id: n.id, type: n.type, data: n.data };
  });
  const canon = {
    nodes,
    edges: (graph.edges || []).map((e) => ({
      source: e.source, sourcePort: e.sourcePort, target: e.target, targetPort: e.targetPort,
    })),
    jobId: jobId ?? null,
    start: start ?? null,
    end: end ?? null,
    signals: referenced,
  };
  return fnv1a(stableStringify(canon));
}
