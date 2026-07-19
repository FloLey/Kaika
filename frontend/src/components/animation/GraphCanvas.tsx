import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject, PointerEvent as RPointerEvent, ReactNode } from "react";
import usePanZoom, { fitView } from "./usePanZoom";
import type { View } from "./usePanZoom";
import { portKey, centerInContainer, edgePath, canConnect, connectIssue } from "./ports";
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

const EMPTY_SEL: ReadonlySet<string> = new Set();

// The unassigned-wire sentinel (mirrors lib/graph/core LOOSE_PORT — the canvas only
// needs it to style loose edges gray and to anchor them to the card body).
const LOOSE_PORT = "__in";

interface NodeCardProps {
  node: GraphNode;
  helpers: Omit<NodeHelpers, "onTitlePointerDown" | "selected">;
  mkTitleDown: (node: GraphNode) => NodeHelpers["onTitlePointerDown"];
  selected: boolean;
  renderNode: (node: GraphNode, helpers: NodeHelpers) => ReactNode;
}

// One node card, memoized: while a drag/pan/edge tick re-renders the canvas many
// times per second, a card whose node/selection/ctx didn't change is skipped
// entirely (the expensive part of the tree — previews, params, video elements).
const NodeCard = memo(function NodeCard({
  node,
  helpers,
  mkTitleDown,
  selected,
  renderNode,
}: NodeCardProps) {
  return <>{renderNode(node, { ...helpers, onTitlePointerDown: mkTitleDown(node), selected })}</>;
});

interface GraphCanvasProps {
  graph: Graph;
  layoutKey?: string;
  onGraphChange?: (updater: Updater) => void;
  onConnect?: (srcId: string, srcPort: string, tgtId: string, tgtPort: string) => void;
  // A wire released over a CARD (not a port): the editor auto-assigns or parks it loose.
  onCardDrop?: (srcId: string, srcFlow: string, tgtId: string) => void;
  onEdgeDelete?: (edge: GraphEdge) => void;
  onDeleteSelection?: (ids: string[]) => void;
  // The active selection: node ids and/or a single edge id. Several nodes can be
  // selected at once (shift/⌘-click or marquee) and then dragged/deleted as a group.
  selected?: ReadonlySet<string>;
  onSelectionChange?: (next: Set<string>) => void;
  onViewChange?: (v: View) => void;
  // Imperative fit-view handle: the canvas writes its fit action here so the
  // toolbar's ⊙ fit button / ⚠ problems rows (owned by Palette, outside this
  // subtree) can call it — no ids = fit everything, ids = center those cards.
  fitRef?: MutableRefObject<((ids?: string[]) => void) | null>;
  // Imperative measure handle (same pattern as fitRef): the cards' rendered wrapper
  // sizes in graph-space px, for the editor's ✨ arrange layout pass.
  measureRef?: MutableRefObject<(() => Map<string, { w: number; h: number }>) | null>;
  renderNode: (node: GraphNode, helpers: NodeHelpers) => ReactNode;
}

export default function GraphCanvas({
  graph,
  layoutKey,
  onGraphChange,
  onConnect,
  onCardDrop,
  onEdgeDelete,
  onDeleteSelection,
  selected = EMPTY_SEL,
  onSelectionChange,
  onViewChange,
  fitRef,
  measureRef,
  renderNode,
}: GraphCanvasProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  // Latest selection / graph in refs so the pointer handlers (memoized, attached as
  // window listeners) read current values without re-subscribing on every edit.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const graphRef = useRef(graph);
  graphRef.current = graph;

  // Live map of node id -> positioned wrapper element, for marquee hit-testing and
  // bbox measurement. offsetWidth/offsetHeight are layout px (unaffected by the
  // stage's CSS scale), so they line up with node.x/node.y (same graph-space units).
  const nodeEls = useRef(new Map<string, HTMLElement>());

  // The measured graph-space bbox of `nodes` (real card sizes, with footprint
  // fallbacks for unmounted ones). Shared by ⊙ fit and the dynamic zoom-out limit.
  const measureBBox = useCallback((nodes: GraphNode[]) => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      const el = nodeEls.current.get(n.id);
      const w = el?.offsetWidth || 230; // fallbacks ≈ default card footprint
      const h = el?.offsetHeight || 160;
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + w);
      maxY = Math.max(maxY, n.y + h);
    }
    return { minX, minY, maxX, maxY };
  }, []);

  // The dynamic zoom-out limit: dezoom is allowed until the WHOLE graph fits ×1.5
  // in both directions — a sprawling pipeline never jams against the static 0.15
  // floor mid-overview. Evaluated per wheel tick, so it tracks drags/adds live.
  const getMinScale = useCallback(() => {
    const root = rootRef.current;
    const nodes = graphRef.current.nodes || [];
    if (!root || !nodes.length) return 0.15;
    const rect = root.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return 0.15;
    const b = measureBBox(nodes);
    const fitScale = Math.min(
      rect.width / Math.max(1, b.maxX - b.minX),
      rect.height / Math.max(1, b.maxY - b.minY)
    );
    return Math.min(0.15, fitScale / 1.5);
  }, [measureBBox]);

  const {
    view,
    onWheel,
    onBackgroundPointerDown,
    onBackgroundPointerMove,
    onBackgroundPointerUp,
    screenToGraph,
    applyView,
  } = usePanZoom(graph, onViewChange, rootRef, getMinScale);

  const replaceSel = useCallback(
    (id: string | null) => onSelectionChange?.(id == null ? new Set() : new Set([id])),
    [onSelectionChange]
  );
  const toggleSel = useCallback(
    (id: string) => {
      const next = new Set(selectedRef.current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      onSelectionChange?.(next);
    },
    [onSelectionChange]
  );

  // ⊙ fit view: bbox over the MEASURED cards (exact heights, compact or full) ->
  // a centered view. fitView is unclamped below 1:1, so however big the graph is,
  // fit always fits. Recovers any card dragged off-screen. Reached via the toolbar
  // button (fitRef) and by double-clicking empty canvas.
  const fitToNodes = useCallback(
    (ids?: string[]) => {
      const root = rootRef.current;
      const all = graphRef.current.nodes || [];
      const nodes = ids?.length ? all.filter((n) => ids.includes(n.id)) : all;
      if (!root || !nodes.length) return;
      const rect = root.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 40) return; // unlaid-out root (hidden/jsdom): nothing to fit into
      applyView(fitView(measureBBox(nodes), { width: rect.width, height: rect.height }));
    },
    [applyView, measureBBox]
  );
  useEffect(() => {
    if (!fitRef) return undefined;
    fitRef.current = fitToNodes;
    return () => {
      fitRef.current = null;
    };
  }, [fitRef, fitToNodes]);

  // Measured card sizes for the ✨ arrange pass — offsetWidth/offsetHeight are
  // graph-space accurate (see the nodeEls comment above).
  useEffect(() => {
    if (!measureRef) return undefined;
    measureRef.current = () => {
      const sizes = new Map<string, { w: number; h: number }>();
      for (const [id, el] of nodeEls.current) {
        // A 0-width card isn't laid out (hidden panel / jsdom) — omit it so the
        // caller falls back to its per-type estimate instead of a zero box.
        if (el.offsetWidth) sizes.set(id, { w: el.offsetWidth, h: el.offsetHeight });
      }
      return sizes;
    };
    return () => {
      measureRef.current = null;
    };
  }, [measureRef]);
  // Open FITTED: one shot per mount (the editor remounts per segment), after the
  // cards have laid out so their real heights are measurable. A saved graph.view
  // can strand every card off-screen — fitting on open means the pipeline is
  // always in front of you; pan/zoom from there is session-local anyway.
  useEffect(() => {
    if ((graphRef.current.nodes || []).length) fitToNodes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // --- node dragging (moves the whole selection in one go) -------------------
  // The gesture is LOCAL to the canvas: per pointermove we track the offset and
  // re-render only this component (a tick) — the moving position wrappers update,
  // while the memoized cards and the app-level graph state stay untouched. The
  // graph is committed ONCE on pointer-up (one onGraphChange, one normalize pass),
  // instead of per move.
  interface DragItem {
    id: string;
    origX: number;
    origY: number;
  }
  interface Drag {
    startX: number;
    startY: number;
    items: DragItem[]; // every selected node, captured at grab time
    clickedId: string;
    wasGroup: boolean; // grabbed a node already part of a multi-selection
    moved: boolean;
    dx: number; // live offset in graph units (applied to items' wrappers)
    dy: number;
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
    [onSelectionChange, toggleSel]
  );

  useEffect(() => {
    if (!drag) return undefined;
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = (e.clientX - d.startX) / scaleRef.current;
      const dy = (e.clientY - d.startY) / scaleRef.current;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) > 0.5) d.moved = true;
      d.dx = dx;
      d.dy = dy;
      tick(); // re-render the wrappers/edges only — no graph commit while dragging
    };
    const up = () => {
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
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [drag, onGraphChange, onSelectionChange, tick]);

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

  // A brief toast explaining why the last connect attempt was rejected. Auto-
  // clears; a fresh attempt replaces it (and resets the timer).
  const [hint, setHint] = useState<string | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showHint = useCallback((msg: string) => {
    setHint(msg);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(null), 2800);
  }, []);
  useEffect(() => () => void (hintTimer.current && clearTimeout(hintTimer.current)), []);

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
    const up = (e: PointerEvent) => {
      const w = wireRef.current;
      if (w && w.target) {
        onConnect?.(w.source.nodeId, w.source.portId, w.target.nodeId, w.target.portId);
      } else if (w) {
        // Dropped without a valid port target. Landing anywhere on a CARD hands the
        // wire to the editor (auto-assign or park it loose); a drop on a port that
        // refused explains why; empty space is just a cancel (no toast).
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        const cardDom = hit?.closest("[data-node-id]");
        const tgtId = cardDom?.getAttribute("data-node-id");
        if (tgtId && tgtId !== w.source.nodeId && onCardDrop) {
          onCardDrop(w.source.nodeId, w.source.flow, tgtId);
          setWire(null);
          return;
        }
        const portDom = hit?.closest("[data-port]");
        const meta = portDom
          ? portMeta.current.get(
              portKey(
                portDom.getAttribute("data-node") || "",
                portDom.getAttribute("data-port") || ""
              )
            )
          : null;
        const issue = connectIssue(w.source, meta);
        if (issue) showHint(issue);
      }
      setWire(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [wire, onConnect, onCardDrop, showHint]);

  // --- marquee (shift-drag the background to box-select cards) ---------------
  interface Marquee {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  }
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const marqueeRef = useRef<Marquee | null>(null);
  marqueeRef.current = marquee;

  const startMarquee = useCallback((e: RPointerEvent) => {
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setMarquee({ x0: x, y0: y, x1: x, y1: y });
  }, []);

  useEffect(() => {
    if (!marquee) return undefined;
    const root = rootRef.current;
    const move = (e: PointerEvent) => {
      if (!root) return;
      const rect = root.getBoundingClientRect();
      setMarquee((m) => (m ? { ...m, x1: e.clientX - rect.left, y1: e.clientY - rect.top } : m));
    };
    const up = () => {
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
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [marquee, screenToGraph, onSelectionChange]);

  // --- background interactions (pan + clear selection) -----------------------
  const bgPointerDown = useCallback(
    (e: RPointerEvent) => {
      if (e.target !== e.currentTarget) return; // only the bare background
      // Shift-drag boxes a selection; a plain drag pans the canvas.
      if (e.shiftKey) {
        e.preventDefault();
        startMarquee(e);
        return;
      }
      onBackgroundPointerDown(e);
    },
    [onBackgroundPointerDown, startMarquee]
  );

  const bgPointerUp = useCallback(
    (e: RPointerEvent) => {
      const moved = onBackgroundPointerUp(e);
      if (!moved && e.target === e.currentTarget && !e.shiftKey) replaceSel(null);
    },
    [onBackgroundPointerUp, replaceSel]
  );

  // --- delete (whole selection, node(s) and/or edge) -------------------------
  const onEdgeDeleteRef = useRef(onEdgeDelete);
  const onDeleteSelectionRef = useRef(onDeleteSelection);
  onEdgeDeleteRef.current = onEdgeDelete;
  onDeleteSelectionRef.current = onDeleteSelection;

  const removeEdge = useCallback(
    (edge: GraphEdge) => {
      if (!edge) return;
      if (onEdgeDeleteRef.current) onEdgeDeleteRef.current(edge);
      else onGraphChange?.((g) => ({ ...g, edges: g.edges.filter((ed) => ed.id !== edge.id) }));
    },
    [onGraphChange]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (selected.size === 0) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      const ids = [...selected];
      if (onDeleteSelectionRef.current) onDeleteSelectionRef.current(ids);
      else
        onGraphChange?.((g) => ({
          ...g,
          nodes: g.nodes.filter((n) => !selected.has(n.id)),
          edges: g.edges.filter((ed) => !selected.has(ed.id)),
        }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, onGraphChange]);

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

  // Stable helper bag (all members are stable callbacks) so the memoized NodeCards
  // can skip re-renders during drag/pan/edge ticks.
  const helpers = useMemo(
    () => ({
      onMove: (id: string, x: number, y: number) =>
        onGraphChange?.((g) => ({
          ...g,
          nodes: g.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)),
        })),
      portRef,
      startConnect,
      onLayoutChange: tick,
    }),
    [onGraphChange, portRef, startConnect, tick]
  );

  // Live drag offsets for the grabbed selection (graph state is untouched mid-drag;
  // dragRef mutates per pointermove and each move tick()s, so this stays current).
  const liveDrag = dragRef.current;
  const dragIds = liveDrag && liveDrag.moved ? new Set(liveDrag.items.map((i) => i.id)) : null;

  return (
    <div
      className="gc-root"
      ref={rootRef}
      onWheel={onWheel}
      onPointerDown={bgPointerDown}
      onPointerMove={onBackgroundPointerMove}
      onPointerUp={bgPointerUp}
      onDoubleClick={(e) => {
        // Double-click on EMPTY canvas (not a card/edge) = fit view — the rescue
        // gesture when a card was dragged off-screen.
        const t = e.target as HTMLElement;
        if (t.closest?.(".anim-node") || t.closest?.(".gc-edge")) return;
        fitToNodes();
      }}
    >
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
            data-node-id={node.id}
            ref={(el) => {
              // The wrapper doubles as the LOOSE-edge anchor: a parked wire draws to
              // the card body itself, so every card (compact or full) can receive one
              // without declaring a port.
              const key = portKey(node.id, LOOSE_PORT);
              if (el) {
                nodeEls.current.set(node.id, el);
                portEls.current.set(key, el);
                portMeta.current.set(key, {
                  nodeId: node.id,
                  portId: LOOSE_PORT,
                  kind: "in",
                  flow: "value",
                });
              } else {
                nodeEls.current.delete(node.id);
                portEls.current.delete(key);
                portMeta.current.delete(key);
              }
            }}
            style={{
              position: "absolute",
              left: node.x + (dragIds?.has(node.id) ? liveDrag!.dx : 0),
              top: node.y + (dragIds?.has(node.id) ? liveDrag!.dy : 0),
            }}
          >
            <NodeCard
              node={node}
              helpers={helpers}
              mkTitleDown={onTitlePointerDown}
              selected={selected.has(node.id)}
              renderNode={renderNode}
            />
          </div>
        ))}
      </div>

      {marquee && (
        <div
          className="gc-marquee"
          style={{
            left: Math.min(marquee.x0, marquee.x1),
            top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0),
            height: Math.abs(marquee.y1 - marquee.y0),
          }}
        />
      )}

      {wire && (
        <svg className="gc-edges gc-edges-wire" width="100%" height="100%">
          <path
            className={"gc-edge-line gc-wire" + (wire.target ? " ok" : "")}
            d={edgePath(wire.x1, wire.y1, wire.x2, wire.y2)}
          />
        </svg>
      )}

      {hint && (
        <div className="gc-hint" role="status">
          <span className="gc-hint-icon">⚠</span>
          <span>{hint}</span>
        </div>
      )}
    </div>
  );
}
