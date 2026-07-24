import type { GraphEdge } from "../../lib/types";

// The unassigned-wire sentinel (mirrors lib/graph/core LOOSE_PORT — the layer only
// needs it to style loose edges gray).
const LOOSE_PORT = "__in";

// One edge, already resolved to SCREEN space: the bezier path plus the midpoint the
// ✕ delete handle sits on.
export interface EdgeGeom {
  id: string;
  edge: GraphEdge;
  d: string;
  mx: number;
  my: number;
}

interface EdgeLayerProps {
  edges: EdgeGeom[];
  selected: ReadonlySet<string>;
  // Shift/meta-click adds to the selection; a plain click replaces it.
  toggleSel: (id: string) => void;
  replaceSel: (id: string) => void;
  removeEdge: (edge: GraphEdge) => void;
}

// The SVG overlay that draws the wires, split out of GraphCanvas purely to get ~35
// lines of nested markup out of a 760-line component.
//
// ⚠ This takes ALREADY-COMPUTED geometry and does no measuring of its own, which is
// the whole contract. GraphCanvas reads the container rect ONCE per render pass and
// maps every edge against that one rect (commit 2f7bb48). Before that hoist, reads
// per pointermove scaled with edge count — 11 edges cost 22 forced layout flushes per
// background pan; after it the count is flat regardless of graph size. Moving the
// rect read or the .map in here would re-open that quietly, since nothing about the
// rendered output would look different.
export default function EdgeLayer({
  edges,
  selected,
  toggleSel,
  replaceSel,
  removeEdge,
}: EdgeLayerProps) {
  return (
    <svg className="gc-edges gc-edges-base" width="100%" height="100%">
      {edges.map((e) => (
        <g
          key={e.id}
          className={
            "gc-edge" +
            (selected.has(e.id) ? " sel" : "") +
            (e.edge.targetPort === LOOSE_PORT ? " unassigned" : "")
          }
        >
          <path
            className="gc-edge-hit"
            d={e.d}
            onPointerDown={(ev) => {
              ev.stopPropagation();
              if (ev.shiftKey || ev.metaKey || ev.ctrlKey) toggleSel(e.id);
              else replaceSel(e.id);
            }}
          />
          <path className="gc-edge-line" d={e.d} />
          <g
            className="gc-edge-del"
            transform={`translate(${e.mx}, ${e.my})`}
            onPointerDown={(ev) => {
              ev.stopPropagation();
              removeEdge(e.edge);
            }}
          >
            <circle r="9" />
            <text textAnchor="middle" dominantBaseline="central">
              ✕
            </text>
          </g>
        </g>
      ))}
    </svg>
  );
}
