// Pure graph-updater builders for a FluidNode's param-port edits (06 §FluidNode).
// Factored out of FluidNode so the binding logic is testable without a DOM and reused
// by the const slider, the lo/hi range control, and the static patches. All return an
// updater `(graph) => graph` for onGraphChange. They target FLUID nodes (the only
// nodes with `data.ports`/`data.static`), so they narrow the matched node to FluidNode.

import type { Binding, FluidNode, Graph, GraphNode } from "../../../lib/types";

type Updater = (g: Graph) => Graph;

const mapNode = (nodeId: string, fn: (n: FluidNode) => GraphNode): Updater => (g) => ({
  ...g,
  nodes: g.nodes.map((n) => (n.id === nodeId && n.type === "fluid" ? fn(n) : n)),
});

// Patch a port's binding.<field> = value (keeps the rest of the binding/port).
function patchBinding(nodeId: string, key: string, patch: Record<string, unknown>): Updater {
  return mapNode(nodeId, (n) => {
    const port = n.data.ports[key];
    return {
      ...n,
      data: {
        ...n.data,
        ports: { ...n.data.ports, [key]: { ...port, binding: { ...port.binding, ...patch } as Binding } },
      },
    };
  });
}

// Set a const-bound param's value.
export const setConstValue = (nodeId: string, key: string, value: number): Updater =>
  patchBinding(nodeId, key, { value });

// Set a node-bound param's lo/hi range.
export const setNodeRange = (nodeId: string, key: string, lo: number, hi: number): Updater =>
  patchBinding(nodeId, key, { lo, hi });

// Patch the fluid node's static params (color, toggles…).
export const patchStatic = (nodeId: string, patch: Record<string, unknown>): Updater =>
  mapNode(nodeId, (n) => ({ ...n, data: { ...n.data, static: { ...n.data.static, ...patch } } }));
