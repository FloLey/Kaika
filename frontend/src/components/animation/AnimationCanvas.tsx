import { useCallback, useRef } from "react";
import type { ReactNode } from "react";
import GraphCanvas from "./GraphCanvas";
import Palette from "./Palette";
import renderAnimNode from "./renderAnimNode";
import { MinimizeContext } from "./nodes/minimizeContext";
import { useGraphEditor } from "./useGraphEditor";
import type { View } from "./usePanZoom";
import type { Graph, GraphNode, OutputSettings, Segment } from "../../lib/types";
import type { NodeCtx, NodeHelpers } from "./nodes/nodeProps";

interface AnimationCanvasProps {
  segment: Segment;
  stems?: NodeCtx["stems"];
  job?: NodeCtx["job"];
  output?: OutputSettings | null;
  lyricLines?: unknown[];
  onSaveLyricLines?: NodeCtx["onSaveLyricLines"];
  groupClock?: NodeCtx["groupClock"];
  groupPlaying?: boolean;
  onOpenOutput?: () => void;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  onGraphChange: (g: Graph) => void;
  setFinalOutput?: NodeCtx["setFinalOutput"];
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
  lyricLines,
  onSaveLyricLines,
  groupClock,
  groupPlaying,
  onOpenOutput,
  isFullscreen,
  onToggleFullscreen,
  onGraphChange: commitGraph,
  setFinalOutput,
}: AnimationCanvasProps) {
  const {
    graph,
    selected,
    setSelected,
    applyUpdater,
    ctx,
    minimizeCtx,
    minimizedKey,
    viewMode,
    setViewMode,
    onConnect,
    onCardDrop,
    onEdgeDelete,
    onDeleteSelection,
  } = useGraphEditor({
    segment,
    stems,
    job,
    output,
    lyricLines,
    onSaveLyricLines,
    groupClock,
    groupPlaying,
    commitGraph,
    setFinalOutput,
  });

  const wrapRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<View>(graph.view || { tx: 0, ty: 0, scale: 1 }); // session-only pan/zoom

  // Stable while ctx is unchanged, so GraphCanvas's memoized cards can skip renders.
  const renderNode = useCallback(
    (node: GraphNode, helpers: NodeHelpers): ReactNode => renderAnimNode(node, helpers, ctx),
    [ctx]
  );

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
        viewMode={viewMode}
        onSetViewMode={graph.nodes.length ? setViewMode : null}
      />
      <div className="anim-stage" ref={wrapRef}>
        <MinimizeContext.Provider value={minimizeCtx}>
          <GraphCanvas
            graph={graph}
            layoutKey={minimizedKey}
            onGraphChange={applyUpdater}
            onConnect={onConnect}
            onCardDrop={onCardDrop}
            onEdgeDelete={onEdgeDelete}
            onDeleteSelection={onDeleteSelection}
            selected={selected}
            onSelectionChange={setSelected}
            onViewChange={(v) => {
              viewRef.current = v;
            }}
            renderNode={renderNode}
          />
        </MinimizeContext.Provider>
      </div>
    </div>
  );
}
