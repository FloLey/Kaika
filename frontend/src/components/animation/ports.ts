// Port-geometry helpers for the hand-built canvas (05). The canvas measures each
// port's on-screen center from its DOM rect (registered via a ref callback) and
// draws SVG bezier edges between them in *screen space* (08 chose screen-space
// overlay for crisp, non-scaling strokes). These helpers are framework-free.

// A stable key for a port registry map. Ports are addressed by node + port id.
export const portKey = (nodeId: string, portId: string): string => `${nodeId}::${portId}`;

// Center of a DOM rect relative to a container's rect (so edges live in the
// container's local screen coordinates regardless of page scroll).
export function centerInContainer(el: Element, containerRect: DOMRect): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return {
    x: r.left + r.width / 2 - containerRect.left,
    y: r.top + r.height / 2 - containerRect.top,
  };
}

// SVG path for a left-to-right bezier between two screen points. Horizontal
// control-point offset scales with the run, clamped so short/long edges both
// read as smooth flow (05 §Edge rendering).
export function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(30, Math.min(120, Math.abs(x2 - x1) * 0.5));
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

export interface PortSide {
  kind: string;
  nodeId: string;
  flow: string;
}

// Whether a connect attempt (drag from an out port to an in port) is legal:
// out -> in, never onto the same node, and the value/video/points flows must match.
export function canConnect(source?: PortSide | null, target?: PortSide | null): boolean {
  if (!source || !target) return false;
  if (source.kind !== "out" || target.kind !== "in") return false;
  if (source.nodeId === target.nodeId) return false;
  return source.flow === target.flow; // "value" | "video" | "points"
}
