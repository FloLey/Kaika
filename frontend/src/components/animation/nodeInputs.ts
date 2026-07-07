// The per-type INPUT descriptor — the single source of truth for what inputs a card
// has, so a picker (InputPicker) can list, VALUE-edit, and wire them without dragging on
// the canvas. Two kinds: `param` (a modulatable port: const value or a [lo,hi]-mapped
// source) and `edge` (a plain typed edge). Some cards have a DYNAMIC group (math/merge
// inputs, combine layers) with add/remove.

import type { Graph, GraphNode, PortFlow } from "../../lib/types";
import { chromeFor } from "./nodes/registry";
import { nodeParams } from "../../lib/nodeParams";
import { videoSource, isLooseEdge } from "../../lib/graphModel";
import {
  addCombineInput,
  addInputPort,
  removeCombineInput,
  removeInputPort,
} from "../../lib/graph/mutations";

export interface InputDesc {
  portId: string; // the edge's targetPort / the param key
  flow: PortFlow; // which output flow can feed it
  label: string;
  kind: "param" | "edge";
  group?: string; // fluid param group (drives the fluid-source/fluid-medium doc section)
  helpKey?: string; // constant help key for dynamic rows (portId is a generated id)
}
export interface DynamicInputs {
  label: string; // "input" / "layer"
  add: (g: Graph, nodeId: string) => Graph;
  remove: (g: Graph, nodeId: string, portId: string) => Graph;
}
export interface CardInputs {
  inputs: InputDesc[];
  dynamic?: DynamicInputs;
}

const paramInputs = (node: GraphNode): InputDesc[] =>
  nodeParams(node.type).map((p) => ({
    portId: p.key,
    flow: "value" as PortFlow,
    label: p.label,
    kind: "param" as const,
    group: p.group,
  }));

// The colour card's meaningful params depend on its mode (mirrors the card body): the
// swatch has none but intensity/opacity; rgb adds r/g/b; gradient adds position. So the
// panel never lists an irrelevant channel.
function colorParamInputs(node: GraphNode): InputDesc[] {
  const mode = (node.data as { mode?: string }).mode || "swatch";
  const keep = new Set(["intensity", "opacity"]);
  if (mode === "rgb") ["r", "g", "b"].forEach((k) => keep.add(k));
  if (mode === "gradient") keep.add("position");
  return paramInputs(node).filter((i) => keep.has(i.portId));
}

// All of a card's current inputs (params + declared edges + current dynamic instances),
// plus the add/remove hooks for its dynamic group when it has one.
export function cardInputs(node: GraphNode): CardInputs {
  const params = paramInputs(node);
  const data = node.data as { inputs?: string[] };
  switch (node.type) {
    case "gate":
    case "shaper":
    case "scope":
      return { inputs: [{ portId: "in", flow: "value", label: "input", kind: "edge" }] };
    case "imagegen":
      return { inputs: [{ portId: "in", flow: "value", label: "gate", kind: "edge" }] };
    case "animate-points":
      return { inputs: [{ portId: "in", flow: "points", label: "points", kind: "edge" }] };
    case "math":
      return {
        inputs: (data.inputs || []).map((portId, i) => ({
          portId,
          flow: "value" as PortFlow,
          label: `input ${i + 1}`,
          kind: "edge" as const,
          helpKey: "input",
        })),
        dynamic: { label: "input", add: addInputPort, remove: removeInputPort },
      };
    case "merge-points":
      return {
        inputs: (data.inputs || []).map((portId, i) => ({
          portId,
          flow: "points" as PortFlow,
          label: `input ${i + 1}`,
          kind: "edge" as const,
          helpKey: "input",
        })),
        dynamic: { label: "input", add: addInputPort, remove: removeInputPort },
      };
    case "combine":
      return {
        inputs: ((node.data as { inputs: { id: string }[] }).inputs || []).map((s, i) => ({
          portId: s.id,
          flow: "video" as PortFlow,
          label: `layer ${i + 1}`,
          kind: "edge" as const,
          helpKey: "layer",
        })),
        dynamic: { label: "layer", add: addCombineInput, remove: removeCombineInput },
      };
    case "color":
      return { inputs: colorParamInputs(node) };
    case "fluid":
      return {
        inputs: [
          ...params,
          { portId: "positions", flow: "points", label: "positions", kind: "edge" },
          { portId: "color", flow: "color", label: "colour", kind: "edge" },
        ],
      };
    case "slideshow":
      return {
        inputs: [...params, { portId: "images", flow: "images", label: "images", kind: "edge" }],
      };
    case "lyrics":
      return {
        inputs: [
          ...params,
          { portId: "fillColor", flow: "color", label: "fill colour", kind: "edge" },
          { portId: "outlineColor", flow: "color", label: "outline colour", kind: "edge" },
        ],
      };
    case "output":
      return { inputs: [{ portId: "video", flow: "video", label: "video", kind: "edge" }] };
    default:
      // image / video / backdrop → params only; signal/lfo/noise/points/pattern have none.
      return { inputs: params };
  }
}

// A fresh card's default name: its type label + the next free counter. Uses the MAX
// existing "<title> k" suffix + 1 (not count+1), so it survives deletes without
// colliding with a still-present higher number.
export function defaultCardName(graph: Graph, type: string): string {
  const title = chromeFor(type).title;
  const re = new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (\\d+)$`);
  let max = 0;
  for (const n of graph.nodes || []) {
    if (n.type !== type) continue;
    const m = (n.name || "").match(re);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${title} ${max + 1}`;
}

// The candidate source nodes for an input of `flow`: every node whose single output is
// that flow (excluding the target itself). Used to populate the picker dropdown.
export function sourcesForFlow(graph: Graph, flow: PortFlow, excludeId: string): GraphNode[] {
  return (graph.nodes || []).filter(
    (n) => n.id !== excludeId && chromeFor(n.type).outFlow === flow
  );
}

// The source node currently feeding an input: a param reads its port binding; a plain
// edge reads its wired source. null when nothing is assigned.
export function inputSource(node: GraphNode, graph: Graph, input: InputDesc): string | null {
  if (input.kind === "param") {
    const ports =
      (node.data as { ports?: Record<string, { binding?: { kind?: string; nodeId?: string } }> })
        .ports || {};
    const b = ports[input.portId]?.binding;
    return b && b.kind === "node" && b.nodeId ? b.nodeId : null;
  }
  return videoSource(graph, node.id, input.portId);
}

export interface SourcePartition {
  loose: { edgeId: string; srcId: string }[]; // parked gray wires into this card
  assigned: string[]; // sources already wired to one of this card's inputs
  other: string[]; // every other candidate of this flow
}

// Split the candidate sources for ONE input into the three dropdown sections the
// compact-wiring UX shows: (1) loose wires parked on this card but not yet assigned,
// (2) sources already assigned to any of THIS card's inputs, (3) everything else — all
// filtered to the input's flow. Deduped so a source appears in exactly one section
// (loose > assigned > other). A pure function of (graph, node, flow) → easy to test.
export function partitionSources(graph: Graph, node: GraphNode, flow: PortFlow): SourcePartition {
  const outIs = (id: string) => {
    const n = graph.nodes.find((x) => x.id === id);
    return !!n && chromeFor(n.type).outFlow === flow;
  };
  // §1 — loose wires into this card, flow-compatible, deduped by source.
  const loose: { edgeId: string; srcId: string }[] = [];
  const looseSeen = new Set<string>();
  for (const e of graph.edges) {
    if (e.target !== node.id || !isLooseEdge(e) || !outIs(e.source) || looseSeen.has(e.source))
      continue;
    looseSeen.add(e.source);
    loose.push({ edgeId: e.id, srcId: e.source });
  }
  // §2 — sources already assigned to one of this card's (flow-compatible) inputs.
  const assignedSet = new Set<string>();
  for (const input of cardInputs(node).inputs) {
    const src = inputSource(node, graph, input);
    if (src && outIs(src) && !looseSeen.has(src)) assignedSet.add(src);
  }
  // §3 — every other candidate of this flow, minus §1/§2.
  const excluded = new Set<string>([...looseSeen, ...assignedSet]);
  const other = sourcesForFlow(graph, flow, node.id)
    .map((n) => n.id)
    .filter((id) => !excluded.has(id));
  return { loose, assigned: [...assignedSet], other };
}
