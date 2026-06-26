import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as RPointerEvent, ReactNode } from "react";
import usePanZoom from "./usePanZoom";
import type { View } from "./usePanZoom";
import { portKey, centerInContainer, edgePath, canConnect } from "./ports";
import type { Graph, GraphEdge, GraphNode } from "../../lib/types";
import type { NodeHelpers } from "./nodes/nodeProps";

// The reusable, node-type-agnostic playground (05). It positions node cards in
// graph space under one pan/zoom transform, draws bezier edges between measured
// port centers (screen-space SVG overlay), and handles drag-node / drag-connect /
// click-select / delete. It knows nothing about signals or fluid — `renderNode`
// (supplied by 06/07) draws the cards; the canvas reports mutations up via
// `onGraphChange(updater)`.

interface PortMeta {
  nodeId: string;
  portId: string;
  kind: string;
  flow: string;
}
type Updater = (g: Graph) => Graph;

interface GraphCanvasProps {
  graph: Graph;
  layoutKey?: string;
  onGraphChange?: (updater: Updater) => void;
  onConnect?: (srcId: string, srcPort: string, tgtId: string, tgtPort: string) => void;
  onNodeDelete?: (node: GraphNode) => void;
  onEdgeDelete?: (edge: GraphEdge) => void;
  selected?: string | null;
  onSelect?: (id: string | null) => void;
  onViewChange?: (v: View) => void;
  renderNode: (node: GraphNode, helpers: NodeHelpers) => ReactNode;
}

export default function GraphCanvas({
  graph,
  layoutKey,
  onGraphChange,
  onConnect,
  onNodeDelete,
  onEdgeDelete,
  selected,
  onSelect,
  onViewChange,
  renderNode,
}: GraphCanvasProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const { view, onWheel, onBackgroundPointerDown, onBackgroundPointerMove, onBackgroundPointerUp } =
    usePanZoom(graph, onViewChange, rootRef);

  // --- port registry: portKey -> DOM element ---------------------------------
  const portEls = useRef(new Map<string, Element>());
  const portMeta = useRef(new Map<string, PortMeta>());
  const portRef = useCallback(
    (nodeId: string, portId: string, kind: string, flow: string) => (el: Element | null) => {
      const key = portKey(nodeId, portId);
      if (el) {
        portEls.current.set(key, el);
        portMeta.current.set(key, { nodeId, portId, kind, flow });
      } else {
        portEls.current.delete(key);
        portMeta.current.delete(key);
      }
    },
    []
  );

  // A render tick to recompute edge geometry on graph / pan / zoom / resize.
  const [, forceTick] = useState(0);
  const tick = useCallback(() => forceTick((n) => n + 1), []);

  // Recompute edges after layout settles (refs attached) and on the triggers.
  useLayoutEffect(() => {
    tick();
  }, [graph, view, tick, layoutKey]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(() => tick());
    ro.observe(root);
    return () => ro.disconnect();
  }, [tick]);

  // --- node dragging ---------------------------------------------------------
  interface Drag {
    id: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  }
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const scaleRef = useRef(view.scale);
  scaleRef.current = view.scale;

  const onTitlePointerDown = useCallback(
    (node: GraphNode) => (e: RPointerEvent) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest?.(".no-drag")) return;
      e.stopPropagation();
      onSelect?.(node.id);
      setDrag({ id: node.id, startX: e.clientX, startY: e.clientY, origX: node.x, origY: node.y });
    },
    [onSelect]
  );

  useEffect(() => {
    if (!drag) return undefined;
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = (e.clientX - d.startX) / scaleRef.current;
      const dy = (e.clientY - d.startY) / scaleRef.current;
      onGraphChange?.((g) => ({
        ...g,
        nodes: g.nodes.map((n) => (n.id === d.id ? { ...n, x: d.origX + dx, y: d.origY + dy } : n)),
      }));
    };
    const up = () => setDrag(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [drag, onGraphChange]);

  // --- connecting (drag from an out port to an in port) ----------------------
  interface Wire {
    source: PortMeta;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    target: PortMeta | null;
  }
  const [wire, setWire] = useState<Wire | null>(null);
  const wireRef = useRef<Wire | null>(null);
  wireRef.current = wire;

  const startConnect = useCallback(
    (nodeId: string, portId: string, flow: string, e: RPointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const root = rootRef.current;
      const el = portEls.current.get(portKey(nodeId, portId));
      if (!root || !el) return;
      const rect = root.getBoundingClientRect();
      const c = centerInContainer(el, rect);
      setWire({
        source: { nodeId, portId, kind: "out", flow },
        x1: c.x,
        y1: c.y,
        x2: c.x,
        y2: c.y,
        target: null,
      });
      (el as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    []
  );

  // Track the cursor and highlight an eligible in-port under it.
  useEffect(() => {
    if (!wire) return undefined;
    const root = rootRef.current;
    const move = (e: PointerEvent) => {
      if (!root) return;
      const rect = root.getBoundingClientRect();
      const x2 = e.clientX - rect.left;
      const y2 = e.clientY - rect.top;
      let target: PortMeta | null = null;
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      const portDom = hit?.closest("[data-port]");
      if (portDom) {
        const key = portKey(
          portDom.getAttribute("data-node") || "",
          portDom.getAttribute("data-port") || ""
        );
        const meta = portMeta.current.get(key);
        if (meta && canConnect(wireRef.current?.source, meta)) target = meta;
      }
      setWire((w) => (w ? { ...w, x2, y2, target } : w));
    };
    const up = () => {
      const w = wireRef.current;
      if (w && w.target) {
        onConnect?.(w.source.nodeId, w.source.portId, w.target.nodeId, w.target.portId);
      }
      setWire(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [wire, onConnect]);

  // --- background interactions (pan + clear selection) -----------------------
  const bgPointerDown = useCallback(
    (e: RPointerEvent) => {
      if (e.target !== e.currentTarget) return; // only the bare background
      onBackgroundPointerDown(e);
    },
    [onBackgroundPointerDown]
  );

  const bgPointerUp = useCallback(
    (e: RPointerEvent) => {
      const moved = onBackgroundPointerUp(e);
      if (!moved && e.target === e.currentTarget) onSelect?.(null);
    },
    [onBackgroundPointerUp, onSelect]
  );

  // --- delete (node or edge) -------------------------------------------------
  const onNodeDeleteRef = useRef(onNodeDelete);
  const onEdgeDeleteRef = useRef(onEdgeDelete);
  onNodeDeleteRef.current = onNodeDelete;
  onEdgeDeleteRef.current = onEdgeDelete;

  const removeEdge = useCallback(
    (edge: GraphEdge) => {
      if (!edge) return;
      if (onEdgeDeleteRef.current) onEdgeDeleteRef.current(edge);
      else onGraphChange?.((g) => ({ ...g, edges: g.edges.filter((ed) => ed.id !== edge.id) }));
      onSelect?.(null);
    },
    [onGraphChange, onSelect]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (!selected) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const edge = (graph.edges || []).find((ed) => ed.id === selected);
      if (edge) {
        e.preventDefault();
        removeEdge(edge);
        return;
      }
      const node = graph.nodes.find((n) => n.id === selected);
      if (node) {
        e.preventDefault();
        if (onNodeDeleteRef.current) onNodeDeleteRef.current(node);
        else onGraphChange?.((g) => ({ ...g, nodes: g.nodes.filter((n2) => n2.id !== node.id) }));
        onSelect?.(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, graph, onGraphChange, onSelect, removeEdge]);

  // --- edge geometry (screen space, recomputed each tick) --------------------
  const edges = (graph.edges || [])
    .map((e) => {
      const a = portEls.current.get(portKey(e.source, e.sourcePort));
      const b = portEls.current.get(portKey(e.target, e.targetPort));
      const root = rootRef.current;
      if (!a || !b || !root) return null;
      const rect = root.getBoundingClientRect();
      const ca = centerInContainer(a, rect);
      const cb = centerInContainer(b, rect);
      return {
        id: e.id,
        edge: e,
        d: edgePath(ca.x, ca.y, cb.x, cb.y),
        mx: (ca.x + cb.x) / 2,
        my: (ca.y + cb.y) / 2,
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  const helpers = {
    onMove: (id: string, x: number, y: number) =>
      onGraphChange?.((g) => ({
        ...g,
        nodes: g.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)),
      })),
    portRef,
    startConnect,
    onTitlePointerDown,
    onLayoutChange: tick,
  };

  return (
    <div
      className="gc-root"
      ref={rootRef}
      onWheel={onWheel}
      onPointerDown={bgPointerDown}
      onPointerMove={onBackgroundPointerMove}
      onPointerUp={bgPointerUp}
    >
      <svg className="gc-edges gc-edges-base" width="100%" height="100%">
        {edges.map((e) => (
          <g key={e.id} className={"gc-edge" + (e.id === selected ? " sel" : "")}>
            <path
              className="gc-edge-hit"
              d={e.d}
              onPointerDown={(ev) => {
                ev.stopPropagation();
                onSelect?.(e.id);
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

      <div
        className="gc-stage"
        ref={stageRef}
        style={{
          transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
          transformOrigin: "0 0",
        }}
      >
        {graph.nodes.map((node) => (
          <div
            key={node.id}
            className="gc-node-pos"
            style={{ position: "absolute", left: node.x, top: node.y }}
          >
            {renderNode(node, {
              ...helpers,
              onTitlePointerDown: onTitlePointerDown(node),
              selected: node.id === selected,
            })}
          </div>
        ))}
      </div>

      {wire && (
        <svg className="gc-edges gc-edges-wire" width="100%" height="100%">
          <path
            className={"gc-edge-line gc-wire" + (wire.target ? " ok" : "")}
            d={edgePath(wire.x1, wire.y1, wire.x2, wire.y2)}
          />
        </svg>
      )}
    </div>
  );
}
