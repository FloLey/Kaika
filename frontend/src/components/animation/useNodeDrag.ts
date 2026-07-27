import { useCallback, useRef, useState } from "react";
import type { MutableRefObject, PointerEvent as RPointerEvent } from "react";
import { useWindowPointer } from "./useWindowPointer";
import type { Graph, GraphNode } from "../../lib/types";

// Dragging cards, one selection at a time.
//
// The gesture is LOCAL to the canvas: per pointermove it tracks an offset and re-renders
// only the canvas (a tick), so the moving position wrappers update while the memoized
// cards and the app-level graph state stay untouched. The graph is committed ONCE on
// pointer-up — one `onGraphChange`, one normalize pass — instead of per move.
//
// That is why `dragRef` is returned rather than the state: the canvas reads the live
// offset out of it while rendering, and the state exists only to arm the window
// listener.

export interface DragItem {
  id: string;
  origX: number;
  origY: number;
}

export interface Drag {
  startX: number;
  startY: number;
  items: DragItem[]; // every selected node, captured at grab time
  clickedId: string;
  wasGroup: boolean; // grabbed a node already part of a multi-selection
  moved: boolean;
  dx: number; // live offset in graph units (applied to items' wrappers)
  dy: number;
}

interface NodeDragOpts {
  graphRef: MutableRefObject<Graph>;
  selectedRef: MutableRefObject<ReadonlySet<string>>;
  // Read live: a zoom mid-drag must not change how far the cards have moved.
  scaleRef: MutableRefObject<number>;
  toggleSel: (id: string) => void;
  onSelectionChange?: (next: Set<string>) => void;
  onGraphChange?: (updater: (g: Graph) => Graph) => void;
  tick: () => void;
}

export function useNodeDrag({
  graphRef,
  selectedRef,
  scaleRef,
  toggleSel,
  onSelectionChange,
  onGraphChange,
  tick,
}: NodeDragOpts) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;

  const onTitlePointerDown = useCallback(
    (node: GraphNode) => (e: RPointerEvent) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest?.(".no-drag")) return;
      e.stopPropagation();
      // Shift / ⌘ / Ctrl-click toggles a card in the selection (no drag).
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        toggleSel(node.id);
        return;
      }
      const cur = selectedRef.current;
      const wasGroup = cur.has(node.id) && cur.size > 1;
      // Grab inside the current multi-selection -> keep it (drag the group). Grab a
      // node that wasn't selected -> it becomes the lone selection.
      const sel: ReadonlySet<string> = cur.has(node.id) ? cur : new Set([node.id]);
      if (!cur.has(node.id)) onSelectionChange?.(new Set(sel));
      const byId = new Map(graphRef.current.nodes.map((n) => [n.id, n]));
      const items: DragItem[] = [];
      for (const id of sel) {
        const n = byId.get(id);
        if (n) items.push({ id: n.id, origX: n.x, origY: n.y });
      }
      setDrag({
        startX: e.clientX,
        startY: e.clientY,
        items,
        clickedId: node.id,
        wasGroup,
        moved: false,
        dx: 0,
        dy: 0,
      });
    },
    [graphRef, selectedRef, onSelectionChange, toggleSel]
  );

  useWindowPointer(
    !!drag,
    (e) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = (e.clientX - d.startX) / scaleRef.current;
      const dy = (e.clientY - d.startY) / scaleRef.current;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) > 0.5) d.moved = true;
      d.dx = dx;
      d.dy = dy;
      tick(); // re-render the wrappers/edges only — no graph commit while dragging
    },
    () => {
      const d = dragRef.current;
      if (d && d.moved) {
        // Commit the final positions in ONE graph update.
        const { items, dx, dy } = d;
        onGraphChange?.((g) => ({
          ...g,
          nodes: g.nodes.map((n) => {
            const it = items.find((i) => i.id === n.id);
            return it ? { ...n, x: it.origX + dx, y: it.origY + dy } : n;
          }),
        }));
      }
      // A plain click (no drag) on a node inside a group collapses to just that node.
      if (d && !d.moved && d.wasGroup) onSelectionChange?.(new Set([d.clickedId]));
      setDrag(null);
    }
  );

  return { dragRef, onTitlePointerDown };
}
