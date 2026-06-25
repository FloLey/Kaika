import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import GraphCanvas from "./GraphCanvas.jsx";
import Palette from "./Palette.jsx";
import renderAnimNode from "./renderAnimNode.jsx";
import { MinimizeContext } from "./nodes/minimizeContext.js";
import {
  emptyGraph, normalizeGraph, connect, disconnect, removeNode, mkEdgeId,
} from "../../lib/graphModel.js";
import { fluidParam } from "../../lib/fluidParams.js";

// 07 — the per-segment animation container. Bridges the graph (lifted to
// segment.graph) <-> GraphCanvas. Rendering is per-output: each OutputNode renders
// its own pipeline (N fluid->output chains per graph), so this container no longer
// owns a single render. Mount it keyed by segment.id so state resets per segment.
//
//   segment        — the active segment ({ id, start, end, signals, graph? })
//   stems, job     — project context (audio + spectrograms)
//   onGraphChange  — (graph) => void; commits the whole graph to segment.graph
export default function AnimationCanvas({
  segment, stems, job, output, groupClock, groupPlaying, onOpenOutput,
  onGraphChange: commitGraph,
}) {
  // A stable graph object: segment.graph when present, else a fresh empty graph.
  // normalizeGraph migrates older saves so every fluid node carries the current
  // param ports (e.g. r/g/b colour) — otherwise wiring those ports silently fails.
  const graph = useMemo(() => normalizeGraph(segment.graph || emptyGraph()), [segment.graph]);
  const [selId, setSelId] = useState(null);

  const wrapRef = useRef(null);
  const panelRef = useRef(null);                  // the whole panel (fullscreen target)
  const viewRef = useRef(graph.view || { tx: 0, ty: 0, scale: 1 }); // session-only pan/zoom
  const [isFull, setIsFull] = useState(false);

  // Fullscreen the playground via the browser Fullscreen API. Track the real state
  // (so Esc / external exits update the button) by listening for fullscreenchange.
  useEffect(() => {
    const onFs = () => setIsFull(document.fullscreenElement === panelRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
  const toggleFullscreen = useCallback(() => {
    const el = panelRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.().catch(() => {});
  }, []);

  // Apply a (graph) => graph updater and lift the result to segment.graph.
  const applyUpdater = useCallback(
    (updater) => commitGraph(updater(graph)),
    [commitGraph, graph]
  );

  // Collapsed-to-header cards. Stored ON the graph (`graph.minimized`) so it
  // persists with the project across reloads, but it's a non-rendering field that
  // graphHash/outputHash ignore — so toggling it never busts the render cache.
  const minimized = useMemo(() => new Set(graph.minimized || []), [graph.minimized]);
  const toggleMinimize = useCallback((id) => {
    applyUpdater((g) => {
      const cur = new Set(g.minimized || []);
      if (cur.has(id)) cur.delete(id); else cur.add(id);
      return { ...g, minimized: [...cur] };
    });
  }, [applyUpdater]);

  // Where to drop a new node: center of the viewport in graph space, staggered so
  // repeated adds don't land exactly on top of each other.
  const centerGraph = useCallback(() => {
    const v = viewRef.current;
    const el = wrapRef.current;
    const w = el ? el.clientWidth : 640;
    const h = el ? el.clientHeight : 420;
    const n = (graph.nodes?.length || 0) % 6;
    return {
      x: (w / 2 - v.tx) / v.scale - 120 + n * 24,
      y: (h / 2 - v.ty) / v.scale - 70 + n * 24,
    };
  }, [graph]);

  // Accept a wire (compatibility already enforced by the canvas): a value source
  // into a fluid param via connect(); fluid -> output as a plain video edge.
  const onConnect = useCallback((srcId, srcPort, tgtId, tgtPort) => {
    applyUpdater((g) => {
      const tgt = g.nodes.find((n) => n.id === tgtId);
      if (tgt && tgt.type === "fluid" && fluidParam(tgtPort)) {
        return connect(g, srcId, tgtId, tgtPort);
      }
      const edges = g.edges.filter((e) => !(e.target === tgtId && e.targetPort === tgtPort));
      edges.push({ id: mkEdgeId(), source: srcId, sourcePort: srcPort, target: tgtId, targetPort: tgtPort });
      return { ...g, edges };
    });
  }, [applyUpdater]);

  const onEdgeDelete = useCallback((edge) => {
    applyUpdater((g) => {
      const tgt = g.nodes.find((n) => n.id === edge.target);
      if (tgt && tgt.type === "fluid" && fluidParam(edge.targetPort)) {
        return disconnect(g, edge.target, edge.targetPort);
      }
      return { ...g, edges: g.edges.filter((e) => e.id !== edge.id) };
    });
    setSelId(null);
  }, [applyUpdater]);

  const onNodeDelete = useCallback((node) => {
    applyUpdater((g) => removeNode(g, node.id));
    setSelId(null);
  }, [applyUpdater]);

  const ctx = {
    segment, stems, job, output,
    signals: segment.signals, graph,
    // the shared segment clock (Studio's refAudio) + transport state, so signal
    // pulse pads and every Output video animate off one playhead. Each OutputNode
    // renders its own pipeline from `graph` + `output` (see OutputNode).
    groupClock, groupPlaying, segStart: segment.start,
    minimized,            // collapsed cards -> renderAnimNode swaps in MinimizedCard
    onGraphChange: applyUpdater,
    onDetach: (fluidId, key) => applyUpdater((g) => disconnect(g, fluidId, key)),
    onDeleteNode: (id) => { applyUpdater((g) => removeNode(g, id)); setSelId(null); },
  };

  // Provided to every NodeFrame's minimize/restore button (so node components need
  // no changes). A stable key feeds GraphCanvas so edges re-anchor on toggle.
  const minimizeCtx = useMemo(() => ({ minimized, toggle: toggleMinimize }), [minimized, toggleMinimize]);
  const minimizedKey = useMemo(() => [...minimized].sort().join(","), [minimized]);
  const allMinimized = graph.nodes.length > 0 && graph.nodes.every((n) => minimized.has(n.id));
  const toggleMinimizeAll = useCallback(() => {
    applyUpdater((g) => ({ ...g, minimized: allMinimized ? [] : g.nodes.map((n) => n.id) }));
  }, [applyUpdater, allMinimized]);

  return (
    <div className={"anim-wrap" + (isFull ? " full" : "")} ref={panelRef}>
      <Palette
        signals={segment.signals}
        centerGraph={centerGraph}
        onOpenOutput={onOpenOutput}
        isFullscreen={isFull}
        onToggleFullscreen={toggleFullscreen}
        onGraphChange={applyUpdater}
        allMinimized={allMinimized}
        onToggleMinimizeAll={graph.nodes.length ? toggleMinimizeAll : null}
      />
      <div className="anim-stage" ref={wrapRef}>
        <MinimizeContext.Provider value={minimizeCtx}>
          <GraphCanvas
            graph={graph}
            layoutKey={minimizedKey}
            onGraphChange={applyUpdater}
            onConnect={onConnect}
            onNodeDelete={onNodeDelete}
            onEdgeDelete={onEdgeDelete}
            selected={selId}
            onSelect={setSelId}
            onViewChange={(v) => { viewRef.current = v; }}
            renderNode={(node, helpers) => renderAnimNode(node, helpers, ctx)}
          />
        </MinimizeContext.Provider>
      </div>
    </div>
  );
}
