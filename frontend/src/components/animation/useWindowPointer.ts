import { useEffect, useRef } from "react";

// A window-level pointer gesture: listen while `active`, stop when it ends.
//
// The canvas runs three of these — dragging nodes, drawing a wire, and the marquee — and
// each had written out the same eight lines: guard, `move`, `up`, two addEventListener
// calls, and a cleanup removing both. Listening on `window` rather than the element is
// deliberate and worth keeping in one place: a drag must keep tracking when the pointer
// leaves the canvas, and must end on a pointerup that happens anywhere.
//
// The handlers are held in refs, so callers pass inline closures without a dependency
// array and the listener is bound exactly once per gesture. That also removes a class of
// bug the originals were exposed to: their handlers closed over state captured when the
// effect ran, so a dependency omitted from the array would silently act on stale values.
// The mutable gesture state was already kept in refs precisely to work around that.
export function useWindowPointer(
  active: boolean,
  onMove: (e: PointerEvent) => void,
  onUp: (e: PointerEvent) => void
): void {
  const moveRef = useRef(onMove);
  const upRef = useRef(onUp);
  moveRef.current = onMove;
  upRef.current = onUp;

  useEffect(() => {
    if (!active) return undefined;
    const move = (e: PointerEvent) => moveRef.current(e);
    const up = (e: PointerEvent) => upRef.current(e);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [active]);
}
