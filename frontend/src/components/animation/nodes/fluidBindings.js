// Pure graph-updater builders for a FluidNode's param-port edits (06 §FluidNode).
// Factored out of FluidNode.jsx so the binding logic is testable without a DOM and
// reused by the const slider, the lo/hi range control, and the static patches.
// All return an updater `(graph) => graph` for onGraphChange.

const mapNode = (nodeId, fn) => (g) => ({
  ...g,
  nodes: g.nodes.map((n) => (n.id === nodeId ? fn(n) : n)),
});

// Patch a port's binding.<field> = value (keeps the rest of the binding/port).
function patchBinding(nodeId, key, patch) {
  return mapNode(nodeId, (n) => {
    const port = n.data.ports[key];
    return {
      ...n,
      data: {
        ...n.data,
        ports: { ...n.data.ports, [key]: { ...port, binding: { ...port.binding, ...patch } } },
      },
    };
  });
}

// Set a const-bound param's value.
export const setConstValue = (nodeId, key, value) => patchBinding(nodeId, key, { value });

// Set a node-bound param's lo/hi range.
export const setNodeRange = (nodeId, key, lo, hi) => patchBinding(nodeId, key, { lo, hi });

// Patch the fluid node's static params (color, duration, toggles…).
export const patchStatic = (nodeId, patch) =>
  mapNode(nodeId, (n) => ({ ...n, data: { ...n.data, static: { ...n.data.static, ...patch } } }));
