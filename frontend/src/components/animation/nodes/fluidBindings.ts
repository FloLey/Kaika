// Pure graph-updater builders for a card's param-port edits (06 §FluidNode). Factored
// out so the binding logic is testable without a DOM and reused by the const slider,
// the lo/hi range control, and the static patches. The binding helpers work on ANY
// ported card (fluid + the FX cards — anything carrying `data.ports`); `patchStatic`
// stays fluid-specific (the fluid card's static toggles).

import type { Binding, FluidNode, FluidPort, Graph, GraphNode } from "../../../lib/types";

type Updater = (g: Graph) => Graph;

// Patch a port's binding.<field> = value on whichever card owns `data.ports`.
function patchBinding(nodeId: string, key: string, patch: Record<string, unknown>): Updater {
  return (g) => ({
    ...g,
    nodes: g.nodes.map((n) => {
      if (n.id !== nodeId || !("ports" in n.data)) return n;
      const ports = (n.data as { ports: Record<string, FluidPort> }).ports;
      const port = ports[key];
      if (!port) return n;
      return {
        ...n,
        data: {
          ...n.data,
          ports: {
            ...ports,
            [key]: { ...port, binding: { ...port.binding, ...patch } as Binding },
          },
        },
      } as GraphNode;
    }),
  });
}

// Set a const-bound param's value.
export const setConstValue = (nodeId: string, key: string, value: number): Updater =>
  patchBinding(nodeId, key, { value });

// Set a node-bound param's lo/hi range.
export const setNodeRange = (nodeId: string, key: string, lo: number, hi: number): Updater =>
  patchBinding(nodeId, key, { lo, hi });

// One edited thumb of the lo–hi range -> the next {lo, hi}, keeping the window at
// least one `step` wide. A zero-width window (lo == hi) maps every source value to
// the same constant — silently killing the modulation (deadly on a `trigger` port,
// where it means "the image never advances") — so the thumbs can meet but never
// fully collapse. Pure so the invariant is unit-testable.
export function clampRangeEdit(
  param: { min: number; max: number; step: number },
  binding: { lo: number; hi: number },
  which: "lo" | "hi",
  value: number
): { lo: number; hi: number } {
  const w = param.step || 0.01;
  if (which === "lo") {
    const lo = Math.max(param.min, Math.min(value, binding.hi - w));
    return { lo, hi: binding.hi };
  }
  const hi = Math.min(param.max, Math.max(value, binding.lo + w));
  return { lo: binding.lo, hi };
}

// Patch the fluid node's static params (color, toggles…).
export const patchStatic =
  (nodeId: string, patch: Record<string, unknown>): Updater =>
  (g) => ({
    ...g,
    nodes: g.nodes.map((n) =>
      n.id === nodeId && n.type === "fluid"
        ? ({
            ...n,
            data: { ...n.data, static: { ...(n as FluidNode).data.static, ...patch } },
          } as GraphNode)
        : n
    ),
  });

// Set the fluid node's cross-segment continuity layer (data.layer, not a static param).
export const setFluidLayer =
  (nodeId: string, layer: number): Updater =>
  (g) => ({
    ...g,
    nodes: g.nodes.map((n) =>
      n.id === nodeId && n.type === "fluid"
        ? ({ ...n, data: { ...n.data, layer } } as GraphNode)
        : n
    ),
  });
