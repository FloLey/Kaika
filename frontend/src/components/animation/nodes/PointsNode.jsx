import { useRef } from "react";
import NodeFrame, { Port } from "./NodeFrame.jsx";
import { addPoint, movePoint, removePoint } from "../../../lib/graphModel.js";

// The points source card (spec 11): a draw surface where you place points.
// Wired into a fluid's `positions` input, the fluid emits one source per point.
// Click empty space to add a point, drag a marker to move it, double-click a marker
// to remove it. The pad adopts the project output aspect so points land where drawn.
// One `out` port (flow "points"). v1 = static points; edits go through graphModel.
export default function PointsNode({ node, selected, helpers, ctx, onGraphChange, onDelete }) {
  const padRef = useRef(null);
  const points = node.data.points || [];
  const aspect = ctx?.output ? `${ctx.output.width} / ${ctx.output.height}` : "1 / 1";

  const norm = (e) => {
    const r = padRef.current.getBoundingClientRect();
    return [
      Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    ];
  };

  const onPadDown = (e) => {
    if (e.target !== e.currentTarget) return;     // ignore clicks landing on a marker
    onGraphChange((g) => addPoint(g, node.id, norm(e)));
  };

  const onMarkerDown = (i, e) => {
    e.stopPropagation();
    const move = (ev) => onGraphChange((g) => movePoint(g, node.id, i, norm(ev)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
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
        style={{ "--out-aspect": aspect }}
        onPointerDown={onPadDown}
      >
        {points.map(([x, y], i) => (
          <span
            key={i}
            className="anim-points-marker"
            style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
            onPointerDown={(e) => onMarkerDown(i, e)}
            onDoubleClick={(e) => { e.stopPropagation(); onGraphChange((g) => removePoint(g, node.id, i)); }}
            title="drag to move · double-click to remove"
          />
        ))}
      </div>
      <div className="anim-points-hint">
        {points.length} point{points.length === 1 ? "" : "s"} · click to add, drag to move,
        dbl-click to remove
      </div>
    </NodeFrame>
  );
}
