import { useCallback, useRef, useState } from "react";
import type { MutableRefObject, PointerEvent as RPointerEvent, RefObject } from "react";
import { useWindowPointer } from "./useWindowPointer";
import type { Graph } from "../../lib/types";

// Shift-dragging the background to box-select cards.
//
// The box is tracked in canvas-local screen space (that is what gets drawn), and only
// converted to graph space once, on release. Selection is an AABB overlap against each
// card's RENDERED size read from the DOM rather than an assumed one: cards differ by
// type, and a minimized card is a fraction of its expanded height.

export interface Marquee {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface MarqueeOpts {
  rootRef: RefObject<HTMLDivElement>;
  graphRef: MutableRefObject<Graph>;
  nodeEls: MutableRefObject<Map<string, HTMLElement>>;
  screenToGraph: (x: number, y: number) => { x: number; y: number };
  onSelectionChange?: (next: Set<string>) => void;
}

export function useMarquee({
  rootRef,
  graphRef,
  nodeEls,
  screenToGraph,
  onSelectionChange,
}: MarqueeOpts) {
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const marqueeRef = useRef<Marquee | null>(null);
  marqueeRef.current = marquee;

  const startMarquee = useCallback(
    (e: RPointerEvent) => {
      const root = rootRef.current;
      if (!root) return;
      const rect = root.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      setMarquee({ x0: x, y0: y, x1: x, y1: y });
    },
    [rootRef]
  );

  useWindowPointer(
    !!marquee,
    (e) => {
      const root = rootRef.current;
      if (!root) return;
      const rect = root.getBoundingClientRect();
      setMarquee((m) => (m ? { ...m, x1: e.clientX - rect.left, y1: e.clientY - rect.top } : m));
    },
    () => {
      const m = marqueeRef.current;
      if (m) {
        // Box corners -> graph space, then AABB-overlap each node's rendered rect.
        const a = screenToGraph(Math.min(m.x0, m.x1), Math.min(m.y0, m.y1));
        const b = screenToGraph(Math.max(m.x0, m.x1), Math.max(m.y0, m.y1));
        const hits = new Set<string>();
        for (const n of graphRef.current.nodes) {
          const el = nodeEls.current.get(n.id);
          const w = el ? el.offsetWidth : 0;
          const h = el ? el.offsetHeight : 0;
          if (n.x < b.x && n.x + w > a.x && n.y < b.y && n.y + h > a.y) hits.add(n.id);
        }
        onSelectionChange?.(hits);
      }
      setMarquee(null);
    }
  );

  return { marquee, startMarquee };
}
