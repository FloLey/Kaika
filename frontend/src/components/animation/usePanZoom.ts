import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent, RefObject, WheelEvent } from "react";

// Owns the canvas pan/zoom transform `{tx, ty, scale}` (05 §usePanZoom). Seeded
// from `graph.view`; exposes a wheel handler that zooms toward the cursor within
// a clamped scale range, and a background-drag pan. Persists the transform back
// up (debounced) so 07 can autosave it onto `graph.view`.

export interface View {
  tx: number;
  ty: number;
  scale: number;
}

const MIN_SCALE = 0.15;
const MAX_SCALE = 2.0;
const clampScale = (s: number) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));

export default function usePanZoom(
  graph: { view?: View } | null | undefined,
  onViewChange: ((v: View) => void) | undefined,
  rootRef: RefObject<HTMLElement | null>
) {
  const seed = (graph && graph.view) || { tx: 0, ty: 0, scale: 1 };
  const [view, setView] = useState<View>({
    tx: seed.tx ?? 0,
    ty: seed.ty ?? 0,
    scale: clampScale(seed.scale ?? 1),
  });

  // Debounced persist of the transform back to the owner (graph.view).
  const persistTimer = useRef<number | null>(null);
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;
  useEffect(() => {
    if (!onViewChangeRef.current) return undefined;
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      onViewChangeRef.current?.(view);
    }, 300);
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
    };
  }, [view]);

  // Wheel = zoom toward the cursor. Keep the graph point under the cursor fixed:
  // solve for the new translate so (cursor - t)/scale stays constant.
  const onWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const root = rootRef.current;
      if (!root) return;
      const rect = root.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      setView((v) => {
        const factor = Math.exp(-e.deltaY * 0.0015);
        const next = clampScale(v.scale * factor);
        const k = next / v.scale;
        return {
          scale: next,
          tx: cx - (cx - v.tx) * k,
          ty: cy - (cy - v.ty) * k,
        };
      });
    },
    [rootRef]
  );

  // Background drag = pan. Returns true if it started a pan (so the caller can
  // also use it to clear selection on a bare click).
  const panState = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const onBackgroundPointerDown = useCallback((e: PointerEvent) => {
    panState.current = { x: e.clientX, y: e.clientY, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, []);

  const onBackgroundPointerMove = useCallback((e: PointerEvent) => {
    const st = panState.current;
    if (!st) return;
    const dx = e.clientX - st.x;
    const dy = e.clientY - st.y;
    if (!st.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    st.moved = true;
    st.x = e.clientX;
    st.y = e.clientY;
    setView((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }));
  }, []);

  const onBackgroundPointerUp = useCallback((e: PointerEvent) => {
    const st = panState.current;
    panState.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    return st ? st.moved : false;
  }, []);

  // Screen point -> graph point, for dropping new nodes at the canvas center.
  const screenToGraph = useCallback(
    (sx: number, sy: number) => ({
      x: (sx - view.tx) / view.scale,
      y: (sy - view.ty) / view.scale,
    }),
    [view]
  );

  return {
    view,
    onWheel,
    onBackgroundPointerDown,
    onBackgroundPointerMove,
    onBackgroundPointerUp,
    screenToGraph,
  };
}
