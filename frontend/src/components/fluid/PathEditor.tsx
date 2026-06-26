import { useRef } from "react";
import type { PointerEvent as RPointerEvent } from "react";
import { useDragPad } from "../../lib/useDragPad";

export type Point = [number, number];

interface PathEditorProps {
  points: Point[];
  pathClosed: boolean;
  onAddPoint: (coord: Point) => void;
  onMovePoint: (idx: number, coord: Point) => void;
  onToggleClosed: () => void;
  onRemovePoint: (idx: number) => void;
}

// The FluidLab source-path overlay: the SVG poly + the draggable numbered markers
// laid over the simulation video. Owns the pad ref + drag plumbing (useDragPad);
// the point list itself stays in FluidLab, mutated through these callbacks.
//
//   click the stage      -> onAddPoint(coord)      (ignored on a marker hit)
//   drag a marker        -> onMovePoint(idx, coord)
//   click the 1st point  -> onToggleClosed()       (close/open the loop)
//   right-click a marker -> onRemovePoint(idx)
export default function PathEditor({
  points, pathClosed, onAddPoint, onMovePoint, onToggleClosed, onRemovePoint,
}: PathEditorProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const { norm: normCoord, startDrag } = useDragPad(stageRef);

  const addPoint = (e: RPointerEvent) => {
    if (e.target !== e.currentTarget) return; // ignore clicks on a marker
    onAddPoint(normCoord(e));
  };

  const onMarkerDown = (idx: number, e: RPointerEvent) => {
    startDrag(e, {
      onMove: (coord) => onMovePoint(idx, coord),
      // Click (no drag) on the FIRST point closes/opens the loop, like a polygon
      // tool. FluidLab guards the minimum-triangle requirement.
      onEnd: ({ moved }) => { if (!moved && idx === 0) onToggleClosed(); },
    });
  };

  return (
    <div className="fluid-overlay" ref={stageRef} onPointerDown={addPoint}>
      <svg className="fluid-path" viewBox="0 0 100 100" preserveAspectRatio="none">
        {points.length > 1 && (() => {
          const pts = points.map(([x, y]) => `${x * 100},${y * 100}`).join(" ");
          return pathClosed
            ? <polygon points={pts} fill="none" />
            : <polyline points={pts} fill="none" />;
        })()}
      </svg>
      {/* Index keys are intentional: the markers are stateless, the path is
          ORDERED, the visible label is the point number, and a drag mutates the
          coord in local state per move (so a coordinate key would remount the
          marker every pointermove). */}
      {points.map(([x, y], i) => (
        <div
          key={i}
          className={"fluid-marker" + (i === 0 ? " first" : "")}
          style={{ left: x * 100 + "%", top: y * 100 + "%" }}
          onPointerDown={(e) => onMarkerDown(i, e)}
          onContextMenu={(e) => { e.preventDefault(); onRemovePoint(i); }}
          title={i === 0
            ? "first point — drag to move · click to close/open the loop · right-click to remove"
            : `point ${i + 1} — drag to move · right-click to remove`}
        >
          {i + 1}
        </div>
      ))}
    </div>
  );
}
