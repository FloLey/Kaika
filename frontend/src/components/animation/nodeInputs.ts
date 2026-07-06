// The per-type INPUT descriptor — the single source of truth for what inputs a card
// has, so a picker (InputPicker) can list + wire them without dragging on the canvas.
// Two kinds: `param` (a modulatable port, wired via connect/disconnect + a binding)
// and `edge` (a plain typed edge, wired via connectVideo). Some cards have a DYNAMIC
// group (math/merge inputs, combine layers) with add/remove.

import type { Graph, GraphNode, PortFlow } from "../../lib/types";
import { chromeFor } from "./nodes/registry";
import { nodeParams } from "../../lib/nodeParams";
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
  }));

// All of a card's current inputs (params + declared edges + current dynamic instances),
// plus the add/remove hooks for its dynamic group when it has one.
export function cardInputs(node: GraphNode): CardInputs {
  const params = paramInputs(node);
  const data = node.data as { inputs?: string[]; inputs2?: unknown };
  switch (node.type) {
    case "gate":
    case "shaper":
    case "scope":
      return { inputs: [{ portId: "in", flow: "value", label: "input", kind: "edge" }] };
    case "imagegen":
      return { inputs: [{ portId: "in", flow: "value", label: "gate", kind: "edge" }] };
    case "math":
      return {
        inputs: (data.inputs || []).map((portId, i) => ({
          portId,
          flow: "value" as PortFlow,
          label: `input ${i + 1}`,
          kind: "edge" as const,
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
        })),
        dynamic: { label: "layer", add: addCombineInput, remove: removeCombineInput },
      };
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
      // color / image / video / backdrop → params only; signal/lfo/noise/points/pattern
      // /animate-points have no inputs.
      return { inputs: params };
  }
}

// The candidate source nodes for an input of `flow`: every node whose single output is
// that flow (excluding the target itself). Used to populate the picker dropdown.
export function sourcesForFlow(graph: Graph, flow: PortFlow, excludeId: string): GraphNode[] {
  return (graph.nodes || []).filter(
    (n) => n.id !== excludeId && chromeFor(n.type).outFlow === flow
  );
}
