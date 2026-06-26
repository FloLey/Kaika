import { useCallback, useRef } from "react";
import GraphCanvas from "./GraphCanvas";
import Palette from "./Palette";
import renderAnimNode from "./renderAnimNode";
import { MinimizeContext } from "./nodes/minimizeContext";
import { useGraphEditor } from "./useGraphEditor";
import type { View } from "./usePanZoom";
import type { Graph, OutputSettings } from "../../lib/types";
import type { NodeCtx } from "./nodes/nodeProps";

interface AnimationCanvasProps {
  segment: NodeCtx["segment"] & { graph?: Graph };
  stems?: NodeCtx["stems"];
  job?: NodeCtx["job"];
  output?: OutputSettings | null;
  groupClock?: NodeCtx["groupClock"];
  groupPlaying?: boolean;
  onOpenOutput?: () => void;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  onGraphChange: (g: Graph) => void;
}

// 07 — the per-segment animation container (the VIEW). The graph state + mutation
// handlers + node `ctx` live in useGraphEditor; this component owns layout: refs,
// fullscreen, where-to-drop-new-nodes, and the JSX. Rendering is per-output (each
// OutputNode renders its own pipeline). Mount it keyed by segment.id so state resets.
//
//   segment        — the active segment ({ id, start, end, signals, graph? })
//   stems, job     — project context (audio + spectrograms)
//   onGraphChange  — (graph) => void; commits the whole graph to segment.graph
export default function AnimationCanvas({
  segment,
  stems,
  job,
  output,
  groupClock,
  groupPlaying,
  onOpenOutput,
  isFullscreen,
  onToggleFullscreen,
  onGraphChange: commitGraph,
}: AnimationCanvasProps) {
  const {
    graph,
    selId,
    setSelId,
    applyUpdater,
    ctx,
    minimizeCtx,
    minimizedKey,
    allMinimized,
    toggleMinimizeAll,
    onConnect,
    onEdgeDelete,
    onNodeDelete,
  } = useGraphEditor({ segment, stems, job, output, groupClock, groupPlaying, commitGraph });

  const wrapRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<View>(graph.view || { tx: 0, ty: 0, scale: 1 }); // session-only pan/zoom

  // Fullscreen is owned by Studio (it fullscreens the whole panel so the timeline +
  // output modal stay visible); we just relay its state/toggle to the toolbar.

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
    <div className="anim-wrap">
      <Palette
        signals={segment.signals}
        centerGraph={centerGraph}
        onOpenOutput={onOpenOutput}
        isFullscreen={isFullscreen}
        onToggleFullscreen={onToggleFullscreen}
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
            onViewChange={(v) => {
              viewRef.current = v;
            }}
            renderNode={(node, helpers) => renderAnimNode(node, helpers, ctx)}
          />
        </MinimizeContext.Provider>
      </div>
    </div>
  );
}
