import { useCallback } from "react";
import type { RefObject } from "react";

// Pointer-drag plumbing shared by the points-source card (PointsNode) and the
// BoxPad. Both place/drag normalized points on a rectangular pad.
//
//   const { norm, startDrag } = useDragPad(padRef);
//   norm(e)                       -> [x, y] in 0..1 within padRef's box (clamped)
//   startDrag(e, { onMove, onEnd }) begins a window-level drag:
//       onMove(coord)             fires per pointermove with the live coord
//       onEnd({ moved, coord })   fires once on pointerup; `moved` is false for a
//                                 click with no drag, `coord` is the last position
//                                 (null if it never moved).
//
// Keeping the move/up listeners on `window` (not the marker) means the drag keeps
// tracking even when the pointer leaves the small pad — the original behaviour.

type Coord = [number, number];
type PointLike = { clientX: number; clientY: number };

interface DragHandlers {
  onMove?: (coord: Coord) => void;
  onEnd?: (info: { moved: boolean; coord: Coord | null }) => void;
}

export function useDragPad(padRef: RefObject<HTMLElement | null>) {
  const norm = useCallback(
    (e: PointLike): Coord => {
      const r = padRef.current!.getBoundingClientRect();
      return [
        Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
        Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
      ];
    },
    [padRef]
  );

  const startDrag = useCallback(
    (e: PointLike & { stopPropagation: () => void }, { onMove, onEnd }: DragHandlers = {}) => {
      e.stopPropagation();
      let moved = false;
      let last: Coord | null = null;
      const move = (ev: PointerEvent) => {
        moved = true;
        last = norm(ev);
        onMove?.(last);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        onEnd?.({ moved, coord: last });
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [norm]
  );

  return { norm, startDrag };
}
