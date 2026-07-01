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

// The reason a connect attempt (drag from an out port onto another port) is
// rejected, as a short human message — or null when the connection is legal.
// Returns null too when there's no target port yet (an in-progress drag over
// empty space isn't a mistake to explain). Drives both the validity check below
// and the toast the canvas pops on a rejected drop.
export function connectIssue(source?: PortSide | null, target?: PortSide | null): string | null {
  if (!source || !target) return null;
  if (target.kind !== "in") return "Drop onto an input port, not an output.";
  if (source.nodeId === target.nodeId) return "A node can't connect to itself.";
  if (source.flow !== target.flow) {
    return `Type mismatch: a ${source.flow} output can't feed a ${target.flow} input.`;
  }
  return null; // "value" | "video" | "points" | "color" all matched
}

// Whether a connect attempt is legal: out -> in, never onto the same node, and
// the value/video/points flows must match. Kept in lockstep with the message
// above so the highlight and the toast can never disagree.
export function canConnect(source?: PortSide | null, target?: PortSide | null): boolean {
  if (!source || !target || source.kind !== "out") return false;
  return connectIssue(source, target) === null;
}
