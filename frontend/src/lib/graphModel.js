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
        enabled: true, radial: false, wrap: true, points: [[0.5, 0.5]], path_speed: 1,
        path_closed: false, path_pingpong: false,
      },
      ports,
    },
  };
}

export function emptyGraph() {
  return { version: 1, nodes: [], edges: [], view: { tx: 0, ty: 0, scale: 1 } };
}

// ---- combine node (spec 10) --------------------------------------------------
// Composes N video inputs into one. mode "merge" = the inputs' emitters share ONE
// simulation (using THIS card's medium); "stack" = render each input and alpha-over
// them in input order (index 0 = top) with per-input opacity. Inputs are ordered
// slots; a video edge targets a slot by its id (targetPort).
const mkSlotId = () => rid("slot");
export const combineSlot = (opacity = 1) => ({ id: mkSlotId(), opacity });
const COMBINE_MEDIUM = { dissipation: 0.95, velocity_dissipation: 0.97, viscosity: 0.0, vorticity: 6.0 };

export function combineNode(x, y) {
  return {
    id: mkNodeId(), type: "combine", x, y,
    data: { mode: "merge", inputs: [combineSlot(), combineSlot()], medium: { ...COMBINE_MEDIUM } },
  };
}

// ---- points node (spec 11) ---------------------------------------------------
// A drawn set of source positions (normalised 0..1). Wired into a fluid's
// `positions` input, the fluid emits one source per point (sharing its params).
// Output port flow is "points". Seeded with one centre point.
export function pointsNode(x, y) {
  return { id: mkNodeId(), type: "points", x, y, data: { points: [[0.5, 0.5]] } };
}

const patchPoints = (graph, id, fn) => ({
  ...graph,
  nodes: graph.nodes.map((n) =>
    n.id === id && n.type === "points"
      ? { ...n, data: { ...n.data, points: fn(n.data.points || []) } }
      : n),
});
export function addPoint(graph, id, p) {
  return patchPoints(graph, id, (pts) => [...pts, [p[0], p[1]]]);
}
export function movePoint(graph, id, i, p) {
  return patchPoints(graph, id, (pts) => pts.map((q, k) => (k === i ? [p[0], p[1]] : q)));
}
export function removePoint(graph, id, i) {
  return patchPoints(graph, id, (pts) => pts.filter((_, k) => k !== i));
}

export const VIDEO_PRODUCERS = new Set(["fluid", "combine", "output"]);

// The node wired into (targetId, targetPort) via a video edge, or null.
export function videoSource(graph, targetId, targetPort) {
  const e = (graph.edges || []).find((x) => x.target === targetId && x.targetPort === targetPort);
  return e ? e.source : null;
}

// Wire a video producer into a target port (output "video" or a combine slot id);
// last-wins (replaces any existing edge into that port).
export function connectVideo(graph, sourceId, sourcePort, targetId, targetPort) {
  const edges = (graph.edges || []).filter((e) => !(e.target === targetId && e.targetPort === targetPort));
  edges.push({ id: mkEdgeId(), source: sourceId, sourcePort, target: targetId, targetPort });
  return { ...graph, edges };
}

const patchCombine = (graph, combineId, fn) => ({
  ...graph,
  nodes: graph.nodes.map((n) =>
    n.id === combineId && n.type === "combine" ? { ...n, data: fn(n.data) } : n),
});

export function addCombineInput(graph, combineId) {
  return patchCombine(graph, combineId, (d) => ({ ...d, inputs: [...d.inputs, combineSlot()] }));
}
export function removeCombineInput(graph, combineId, slotId) {
  const g = patchCombine(graph, combineId, (d) => ({ ...d, inputs: d.inputs.filter((s) => s.id !== slotId) }));
  return { ...g, edges: g.edges.filter((e) => !(e.target === combineId && e.targetPort === slotId)) };
}
export function setCombineMode(graph, combineId, mode) {
  return patchCombine(graph, combineId, (d) => ({ ...d, mode }));
}
export function setCombineOpacity(graph, combineId, slotId, opacity) {
  return patchCombine(graph, combineId, (d) => ({
    ...d, inputs: d.inputs.map((s) => (s.id === slotId ? { ...s, opacity } : s)),
  }));
}
export function setCombineMedium(graph, combineId, key, value) {
  return patchCombine(graph, combineId, (d) => ({ ...d, medium: { ...d.medium, [key]: value } }));
}

// Whether `nodeId` resolves to fluid emitter(s) for a merge (no stack upstream).
function isEmitterSource(graph, nodeId, byId, seen = new Set()) {
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
    if (n.type === "points") {
      const pts = Array.isArray(n.data?.points) ? n.data.points : [[0.5, 0.5]];
      if (pts !== n.data?.points) changed = true;
      return { ...n, data: { ...n.data, points: pts } };
    }
    if (n.type === "combine") {
      // Ensure a combine carries mode / inputs / medium (older/partial saves).
      const d = n.data || {};
      const inputs = Array.isArray(d.inputs) && d.inputs.length
        ? d.inputs.map((s) => ({ id: s.id || mkSlotId(), opacity: s.opacity ?? 1 }))
        : [combineSlot(), combineSlot()];
      const data = { mode: d.mode || "merge", inputs, medium: { ...COMBINE_MEDIUM, ...(d.medium || {}) } };
      if (JSON.stringify(data) !== JSON.stringify(d)) changed = true;
      return { ...n, data };
    }
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
  // Drop edges that targeted a now-removed fluid PARAM port (keeps the §3.3
  // invariant). `positions` (the points input, spec 11) is a non-param fluid input,
  // so it's allowed — don't drop it.
  const valid = new Set([...FLUID_PARAM_KEYS, "positions"]);
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
  const out = { ...graph, nodes, edges };
  // Drop the removed node from the persisted minimize set (no stale ids).
  if (Array.isArray(graph.minimized) && graph.minimized.includes(nodeId)) {
    out.minimized = graph.minimized.filter((id) => id !== nodeId);
  }
  return out;
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

// The video producer feeding `outputId` via its single `video` in-edge, or null
// (mirrors backend validate). A producer is a fluid, combine, or output-passthrough.
export function videoInput(graph, outputId) {
  const incoming = (graph.edges || []).filter((e) => e.target === outputId && e.targetPort === "video");
  if (incoming.length !== 1) return null;
  const src = (graph.nodes || []).find((n) => n.id === incoming[0].source);
  return src && VIDEO_PRODUCERS.has(src.type) ? src : null;
}
// Back-compat alias (the fluid feeding an output, if it's wired directly to one).
export function fluidForOutput(graph, outputId) {
  const src = videoInput(graph, outputId);
  return src && src.type === "fluid" ? src : null;
}

export const outputNodes = (graph) =>
  (graph.nodes || []).filter((n) => n.type === "output");

// All node ids upstream of `outputId` — a backward walk over every edge (video DAG
// + value bindings). Mirrors backend `_contributing_ids`.
function outputContributing(graph, outputId) {
  const incoming = new Map();
  for (const e of graph.edges || []) {
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target).push(e.source);
  }
  const seen = new Set();
  const stack = [outputId];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const s of incoming.get(id) || []) stack.push(s);
  }
  return seen;
}

// Whether one output is renderable: a video producer feeds it AND its whole
// contributing video DAG is complete (fluid bindings resolve, each combine has a
// wired input, merges are emitter-resolvable, passthrough outputs have an input).
export function outputRenderable(graph, outputId) {
  if (!videoInput(graph, outputId)) return false;
  const byId = new Map((graph.nodes || []).map((n) => [n.id, n]));
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

export function validate(graph) {
  if (!graph || !Array.isArray(graph.nodes)) return { ok: false, error: "no graph" };
  const nodes = graph.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // 1. at least one output; each wired to exactly one video producer (fluid /
  //    combine / output-passthrough). N independent pipelines are allowed.
  const outputs = nodes.filter((n) => n.type === "output");
  if (outputs.length < 1) return { ok: false, error: "graph needs at least one output node" };
  for (const out of outputs) {
    if (!videoInput(graph, out.id)) {
      return { ok: false, error: "an output is not wired to exactly one source" };
    }
  }

  // 2. every fluid's node-bindings resolve to an existing node.
  for (const n of nodes.filter((x) => x.type === "fluid")) {
    for (const [key, port] of Object.entries(n.data.ports || {})) {
      const b = port.binding;
      if (b && b.kind === "node" && !byId.has(b.nodeId)) {
        return { ok: false, error: `port "${key}" is bound to a missing node` };
      }
    }
  }

  // 2b. a merge combine's inputs must resolve to fluid emitters (no stack upstream).
  for (const cb of nodes.filter((x) => x.type === "combine")) {
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

// Ids of the nodes that actually feed the render: walk edges backwards
// (target -> source) from every output node. Disconnected/orphan nodes don't
// affect the output, so excluding them means adding or editing one won't bust the
// render cache — only changes upstream of the output recompute.
function contributingIds(graph) {
  const incoming = new Map(); // nodeId -> [source ids]
  for (const e of graph.edges || []) {
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target).push(e.source);
  }
  const seen = new Set();
  const stack = (graph.nodes || []).filter((n) => n.type === "output").map((n) => n.id);
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const src of incoming.get(id) || []) stack.push(src);
  }
  return seen;
}

// Stable hash over the CONTRIBUTING nodes (type + data, minus x/y/view), the edges
// among them, the segment bounds + job id, and the defining fields of every signal
// referenced by a contributing `signal` node. `signals` is the segment's signal
// list (for resolving refs). Nodes not upstream of the output are ignored, so the
// key only changes when the rendered output would.
export function graphHash(graph, jobId, start, end, signals) {
  const sigById = new Map((signals || []).map((s) => [s.id, s]));
  const contributing = contributingIds(graph);
  const referenced = {};
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
      // exclude x/y; keep id, type, data (data carries no transient view fields).
      return { id: n.id, type: n.type, data: n.data };
    });
  const canon = {
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

// Per-output subgraph hash: gates redundant POSTs for ONE output. Covers the WHOLE
// contributing video DAG upstream of `outputId` (fluids, combines, output
// pass-throughs, value/signal nodes) + the edges among them + bounds + jobId. So
// editing pipeline B never busts A's cache; moving a node / unrelated signal is a
// no-op. Mirrors backend `output_hash`.
export function outputHash(graph, outputId, jobId, start, end, signals) {
  const contributing = outputContributing(graph, outputId);
  const sigById = new Map((signals || []).map((s) => [s.id, s]));
  const referenced = {};
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
