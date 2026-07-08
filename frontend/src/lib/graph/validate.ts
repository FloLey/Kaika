// Graph validation (01 §3.7) + renderability. Mirrors the backend's validate /
// contributing-subgraph walks (backend/graph_validate.py, graph_hash.py) — the
// backend stays authoritative; this gates obviously-broken graphs client-side.

import { VIDEO_FX, VIDEO_PRODUCERS, isLooseEdge, portsOf, videoSource } from "./core";
import type { CombineNode, Graph, GraphEdge, GraphNode, ValidationResult } from "../types";

// Whether `nodeId` resolves to fluid emitter(s) for a merge (no stack upstream).
function isEmitterSource(
  graph: Graph,
  nodeId: string,
  byId: Map<string, GraphNode>,
  seen = new Set<string>()
): boolean {
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


// ---- validation (01 §3.7) ----------------------------------------------------

// The video producer feeding `outputId` via its single `video` in-edge, or null
// (mirrors backend validate). A producer is a fluid, combine, or output-passthrough.
export function videoInput(graph: Graph, outputId: string): GraphNode | null {
  const incoming = (graph.edges || []).filter(
    (e) => e.target === outputId && e.targetPort === "video"
  );
  if (incoming.length !== 1) return null;
  const src = (graph.nodes || []).find((n) => n.id === incoming[0].source);
  return src && VIDEO_PRODUCERS.has(src.type) ? src : null;
}

// All node ids upstream of `outputId` — a backward walk over every edge (video DAG
// + value bindings). Mirrors backend `_contributing_ids`.
export function outputContributing(graph: Graph, outputId: string): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const e of graph.edges || []) {
    if (isLooseEdge(e)) continue; // an unassigned wire feeds nothing

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

// Whether the contributing video DAG upstream of `rootId` (inclusive) is complete:
// fluid bindings resolve, each combine has a wired input, merges are
// emitter-resolvable, passthrough outputs have an input. Shared by the output check
// and the producer-preview check below.
function contributingComplete(graph: Graph, rootId: string): boolean {
  const byId = new Map<string, GraphNode>((graph.nodes || []).map((n) => [n.id, n]));
  for (const nid of outputContributing(graph, rootId)) {
    const n = byId.get(nid);
    if (!n) continue;
    for (const port of Object.values(portsOf(n) || {})) {
      const b = port.binding;
      if (b && b.kind === "node" && !byId.has(b.nodeId)) return false;
    }
    if (n.type === "combine") {
      const wired = (n.data.inputs || []).some((s) => videoSource(graph, nid, s.id) != null);
      if (!wired) return false;
      if (n.data.mode === "merge") {
        for (const slot of n.data.inputs || []) {
          const src = videoSource(graph, nid, slot.id);
          if (src != null && !isEmitterSource(graph, src, byId)) return false;
        }
      }
    } else if (n.type === "output" && nid !== rootId) {
      if (videoSource(graph, nid, "video") == null) return false;
    } else if (VIDEO_FX.has(n.type)) {
      // An FX card warps a stream it doesn't have yet — unrenderable even as the
      // preview root (the backend raises on an unwired transform either way).
      if (videoSource(graph, nid, "video") == null) return false;
    }
  }
  return true;
}

// Whether one output is renderable: a video producer feeds it AND its whole
// contributing video DAG is complete.
export function outputRenderable(graph: Graph, outputId: string): boolean {
  if (!videoInput(graph, outputId)) return false;
  return contributingComplete(graph, outputId);
}

// Whether ANY node's video can render: an output defers to outputRenderable; any
// other node is a producer previewed directly (fluid / combine card previews) —
// mirrors the backend's _render_target contract, so the card only streams what the
// backend would accept.
export function nodeRenderable(graph: Graph, nodeId: string): boolean {
  const node = (graph.nodes || []).find((n) => n.id === nodeId);
  if (!node) return false;
  if (node.type === "output") return outputRenderable(graph, nodeId);
  return contributingComplete(graph, nodeId);
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

  // 2. every modulatable port binding (fluid OR an FX card) is well-formed (const
  //    numeric / node resolves to an existing node with numeric lo/hi). Mirrors
  //    backend graph._validate_binding.
  for (const n of nodes) {
    for (const [key, port] of Object.entries(portsOf(n) || {})) {
      // Loosen the type: validate is the boundary that catches malformed runtime data.
      const b = port.binding as
        | { kind?: string; value?: unknown; nodeId?: string; lo?: unknown; hi?: unknown }
        | undefined;
      if (!b || !b.kind) continue; // unbound port -> param default
      if (b.kind === "const") {
        if (typeof b.value !== "number")
          return { ok: false, error: `port "${key}" const binding is not numeric` };
      } else if (b.kind === "node") {
        if (!b.nodeId || !byId.has(b.nodeId))
          return { ok: false, error: `port "${key}" is bound to a missing node` };
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
  if (hasCycle(nodes, (graph.edges || []).filter((e) => !isLooseEdge(e)))) {
    return { ok: false, error: "graph has a cycle" };
  }

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
