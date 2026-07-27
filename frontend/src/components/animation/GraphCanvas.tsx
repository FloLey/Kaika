import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject, PointerEvent as RPointerEvent, ReactNode } from "react";
import usePanZoom, { fitView } from "./usePanZoom";
import type { View } from "./usePanZoom";
import { portKey, centerInContainer, edgePath } from "./ports";
import type { PortMeta } from "./ports";
import EdgeLayer from "./EdgeLayer";
import { useNodeDrag } from "./useNodeDrag";
import { useWireConnect } from "./useWireConnect";
import { useMarquee } from "./useMarquee";
import type { Graph, GraphEdge, GraphNode } from "../../lib/types";
import type { NodeHelpers } from "./nodes/nodeProps";

// The reusable, node-type-agnostic playground (05). It positions node cards in
// graph space under one pan/zoom transform, draws bezier edges between measured
// port centers (screen-space SVG overlay), and handles drag-node / drag-connect /
// click-select / delete. It knows nothing about signals or fluid — `renderNode`
// (supplied by 06/07) draws the cards; the canvas reports mutations up via
// `onGraphChange(updater)`.

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
  onConnect?: (
    srcId: string,
    srcPort: string,
    tgtId: string,
    tgtPort: string,
    at?: { x: number; y: number }
  ) => void;
  // A wire released over a CARD (not a port): the editor auto-assigns, opens a port
  // menu at `at`, or parks it loose.
  onCardDrop?: (
    srcId: string,
    srcFlow: string,
    tgtId: string,
    at?: { x: number; y: number }
  ) => void;
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

  // The measured bbox, cached across a zoom GESTURE. `measureBBox` reads offsetWidth +
  // offsetHeight per card — forced synchronous layout — and `getMinScale` runs on every
  // wheel tick, so a 40-card graph did ~80 layout reads per tick, ~60 ticks/sec on a
  // trackpad. The bbox cannot change during a zoom: it is built from node x/y and
  // rendered card sizes, and `view` affects neither.
  //
  // Invalidated by exactly what CAN change it: `graph` (positions, cards added/removed),
  // `layoutKey` (minimize/expand — a card that grew without the graph changing, which is
  // the case a graph-identity cache alone would miss), and the ResizeObserver below.
  // Deliberately NOT `view`.
  //
  // ⚠ One accepted staleness: a node drag mutates position via ref and only commits to
  // `graph` on pointer-up (see the drag handler), so mid-drag the limit reflects the
  // pre-drag layout. Zooming *during* a card drag is not a real gesture, and the commit
  // invalidates immediately.
  const bboxRef = useRef<{ epoch: number; box: ReturnType<typeof measureBBox> } | null>(null);
  const bboxEpoch = useRef(0);
  const invalidateBBox = useCallback(() => {
    bboxEpoch.current += 1;
  }, []);
  useLayoutEffect(invalidateBBox, [graph, layoutKey, invalidateBBox]);

  const cachedBBox = useCallback(
    (nodes: GraphNode[]) => {
      const c = bboxRef.current;
      if (c && c.epoch === bboxEpoch.current) return c.box;
      const box = measureBBox(nodes);
      bboxRef.current = { epoch: bboxEpoch.current, box };
      return box;
    },
    [measureBBox]
  );

  // The dynamic zoom-out limit: dezoom is allowed until the WHOLE graph fits ×1.5
  // in both directions — a sprawling pipeline never jams against the static 0.15
  // floor mid-overview.
  const getMinScale = useCallback(() => {
    const root = rootRef.current;
    const nodes = graphRef.current.nodes || [];
    if (!root || !nodes.length) return 0.15;
    const rect = root.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return 0.15;
    const b = cachedBBox(nodes);
    const fitScale = Math.min(
      rect.width / Math.max(1, b.maxX - b.minX),
      rect.height / Math.max(1, b.maxY - b.minY)
    );
    return Math.min(0.15, fitScale / 1.5);
  }, [cachedBBox]);

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

  // Read live by the drag gesture: zooming mid-drag must not change how far the
  // grabbed cards have travelled.
  const scaleRef = useRef(view.scale);
  scaleRef.current = view.scale;

  // Recompute edges after layout settles (refs attached) and on the triggers.
  useLayoutEffect(() => {
    tick();
  }, [graph, view, tick, layoutKey]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(() => {
      invalidateBBox(); // the container resized, so the fit scale changed
      tick();
    });
    ro.observe(root);
    return () => ro.disconnect();
  }, [tick, invalidateBBox]);

  // --- gestures ---------------------------------------------------------------
  // Three window-level pointer machines, one file each. They stayed inline here long
  // enough for the file to reach 749 lines; each is self-contained (its own state, its
  // own refs, its own `useWindowPointer`) and none of them reads the JSX below.
  const { dragRef, onTitlePointerDown } = useNodeDrag({
    graphRef,
    selectedRef,
    scaleRef,
    toggleSel,
    onSelectionChange,
    onGraphChange,
    tick,
  });

  const { wire, hint, startConnect } = useWireConnect({
    rootRef,
    portEls,
    portMeta,
    onConnect,
    onCardDrop,
  });

  const { marquee, startMarquee } = useMarquee({
    rootRef,
    graphRef,
    nodeEls,
    screenToGraph,
    onSelectionChange,
  });

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
  // The container rect is read ONCE for the whole pass, not once per edge. It cannot
  // change between edges — it is the same element in the same layout — and
  // getBoundingClientRect forces synchronous layout, so the per-edge form cost one flush
  // per edge per render. Measured on a 12-card / 11-edge graph: a single background-pan
  // pointermove did 22 reads (11 edges x 2 renders, since setView re-renders and the
  // layout effect's tick re-renders again); hoisting takes that to 2.
  const edgeRect = rootRef.current?.getBoundingClientRect() ?? null;
  const edges = (graph.edges || [])
    .map((e) => {
      const a = portEls.current.get(portKey(e.source, e.sourcePort));
      const b = portEls.current.get(portKey(e.target, e.targetPort));
      if (!a || !b || !edgeRect) return null;
      const rect = edgeRect;
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
      portRef,
      startConnect,
      onLayoutChange: tick,
    }),
    [portRef, startConnect, tick]
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
      <EdgeLayer
        edges={edges}
        selected={selected}
        toggleSel={toggleSel}
        replaceSel={replaceSel}
        removeEdge={removeEdge}
      />

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
