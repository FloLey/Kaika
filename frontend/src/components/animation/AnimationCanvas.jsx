import { useCallback, useRef } from "react";
import GraphCanvas from "./GraphCanvas.jsx";
import Palette from "./Palette.jsx";
import renderAnimNode from "./renderAnimNode.jsx";
import { MinimizeContext } from "./nodes/minimizeContext.js";
import { useGraphEditor } from "./useGraphEditor";

// 07 — the per-segment animation container (the VIEW). The graph state + mutation
// handlers + node `ctx` live in useGraphEditor; this component owns layout: refs,
// fullscreen, where-to-drop-new-nodes, and the JSX. Rendering is per-output (each
// OutputNode renders its own pipeline). Mount it keyed by segment.id so state resets.
//
//   segment        — the active segment ({ id, start, end, signals, graph? })
//   stems, job     — project context (audio + spectrograms)
//   onGraphChange  — (graph) => void; commits the whole graph to segment.graph
export default function AnimationCanvas({
  segment, stems, job, output, groupClock, groupPlaying, onOpenOutput,
  onGraphChange: commitGraph,
}) {
  const {
    graph, selId, setSelId, applyUpdater, ctx,
    minimizeCtx, minimizedKey, allMinimized, toggleMinimizeAll,
    onConnect, onEdgeDelete, onNodeDelete,
  } = useGraphEditor({ segment, stems, job, output, groupClock, groupPlaying, commitGraph });

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
