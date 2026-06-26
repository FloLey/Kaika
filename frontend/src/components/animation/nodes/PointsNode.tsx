import { useRef, useState } from "react";
import type { CSSProperties, PointerEvent } from "react";
import NodeFrame, { Port } from "./NodeFrame";
import { addPoint, movePoint, removePoint } from "../../../lib/graphModel";
import { useDragPad } from "../../../lib/useDragPad";
import { aspectOf } from "../../../lib/output";
import type { NodeProps } from "./nodeProps";
import type { PointsData } from "../../../lib/types";

type Point = [number, number];

// The points source card (spec 11): a draw surface where you place points.
// Wired into a fluid's `positions` input, the fluid emits one source per point.
// Click empty space to add a point, drag a marker to move it, double-click a marker
// to remove it. The pad adopts the project output aspect so points land where drawn.
// One `out` port (flow "points"). v1 = static points; edits go through graphModel.
export default function PointsNode({ node, selected, helpers, ctx, onGraphChange, onDelete }: NodeProps) {
  const padRef = useRef<HTMLDivElement>(null);
  const { norm, startDrag } = useDragPad(padRef);
  const points = (node.data as PointsData).points || [];
  const aspect = ctx?.output ? aspectOf(ctx.output) : "1 / 1";

  // The marker being dragged tracks against local state and commits to the graph
  // once on pointer-up — dragging no longer replaces the whole segment graph (and
  // re-runs autosave + canvas edge geometry) on every pointermove.
  const [drag, setDrag] = useState<{ i: number; coord: Point } | null>(null);

  const onPadDown = (e: PointerEvent) => {
    if (e.target !== e.currentTarget) return;     // ignore clicks landing on a marker
    onGraphChange((g) => addPoint(g, node.id, norm(e)));
  };

  const onMarkerDown = (i: number, e: PointerEvent) => {
    startDrag(e, {
      onMove: (coord) => setDrag({ i, coord }),
      onEnd: ({ moved, coord }) => {
        setDrag(null);
        if (moved && coord) onGraphChange((g) => movePoint(g, node.id, i, coord));
      },
    });
  };

  return (
    <NodeFrame
      node={node}
      title="points"
      accent="var(--courant)"
      selected={selected}
      onTitlePointerDown={helpers.onTitlePointerDown}
      onDelete={onDelete}
      sideOut={
        <Port
          kind="out"
          flow="points"
          nodeId={node.id}
          portId="out"
          portRef={helpers.portRef}
          startConnect={helpers.startConnect}
          title="points out"
        />
      }
    >
      <div
        className="anim-points-pad no-drag"
        ref={padRef}
        style={{ "--out-aspect": aspect } as CSSProperties}
        onPointerDown={onPadDown}
      >
        {points.map(([x, y], i) => {
          const [px, py] = drag && drag.i === i ? drag.coord : [x, y];
          // Key by the committed coordinate (points are an unordered emitter set,
          // and a drag previews in local state so data coords are stable mid-drag),
          // so removing a point doesn't reshuffle the others' DOM identity.
          return (
            <span
              key={`${x},${y}`}
              className="anim-points-marker"
              style={{ left: `${px * 100}%`, top: `${py * 100}%` }}
              onPointerDown={(e) => onMarkerDown(i, e)}
              onDoubleClick={(e) => { e.stopPropagation(); onGraphChange((g) => removePoint(g, node.id, i)); }}
              title="drag to move · double-click to remove"
            />
          );
        })}
      </div>
      <div className="anim-points-hint">
        {points.length} point{points.length === 1 ? "" : "s"} · click to add, drag to move,
        dbl-click to remove
      </div>
    </NodeFrame>
  );
}
