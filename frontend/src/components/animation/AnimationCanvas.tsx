import { useCallback, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import GraphCanvas from "./GraphCanvas";
import Palette from "./Palette";
import renderAnimNode from "./renderAnimNode";
import { MinimizeContext } from "./nodes/minimizeContext";
import { useGraphEditor } from "./useGraphEditor";
import { problemsFor } from "../../lib/graphModel";
import type { View } from "./usePanZoom";
import type { Graph, GraphNode, LyricLine, OutputSettings, Segment } from "../../lib/types";
import type { NodeCtx, NodeHelpers } from "./nodes/nodeProps";

interface AnimationCanvasProps {
  segment: Segment;
  graph?: Graph | null; // the active composition's graph (null = none built yet)
  finalOutputId?: string; // the composition's ★-final output mark
  stems?: NodeCtx["stems"];
  job?: NodeCtx["job"];
  output?: OutputSettings | null;
  exportSettings?: NodeCtx["exportSettings"];
  assets?: NodeCtx["assets"];
  lyricLines?: LyricLine[];
  onSaveLyricLines?: NodeCtx["onSaveLyricLines"];
  groupClock?: NodeCtx["groupClock"];
  groupPlaying?: boolean;
  onOpenOutput?: () => void;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  onGraphChange: (g: Graph) => void;
  setFinalOutput?: NodeCtx["setFinalOutput"];
}

// 07 — the per-composition animation container (the VIEW). The graph state +
// mutation handlers + node `ctx` live in useGraphEditor; this component owns layout:
// refs, fullscreen, where-to-drop-new-nodes, and the JSX. Rendering is per-output
// (each OutputNode renders its own pipeline). Mount it keyed by segment.id so state
// resets.
//
//   segment        — the host segment ({ id, start, end, signals })
//   graph          — the active composition's graph (lives in the pool, not on segment)
//   stems, job     — project context (audio + spectrograms)
//   onGraphChange  — (graph) => void; commits the whole graph to the composition pool
export default function AnimationCanvas({
  segment,
  graph: compGraph,
  finalOutputId,
  stems,
  job,
  output,
  exportSettings,
  assets,
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
    reorganize,
    ctx,
    minimizeCtx,
    minimizedKey,
    onConnect,
    onCardDrop,
    onEdgeDelete,
    onDeleteSelection,
    undo,
    redo,
    canUndo,
    canRedo,
  } = useGraphEditor({
    segment,
    graph: compGraph,
    finalOutputId,
    stems,
    job,
    output,
    exportSettings,
    assets,
    lyricLines,
    onSaveLyricLines,
    groupClock,
    groupPlaying,
    commitGraph,
    setFinalOutput,
  });

  const wrapRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<View>(graph.view || { tx: 0, ty: 0, scale: 1 }); // session-only pan/zoom
  const fitRef = useRef<((ids?: string[]) => void) | null>(null); // GraphCanvas's ⊙ fit action
  const measureRef = useRef<(() => Map<string, { w: number; h: number }>) | null>(null); // rendered card sizes

  // ✨ arrange: layout the current view with the cards' measured sizes, then re-fit
  // once the new positions have rendered (the timeout lets React flush the commit).
  const onReorganize = useCallback(() => {
    reorganize(measureRef.current?.() ?? new Map());
    setTimeout(() => fitRef.current?.(), 0);
  }, [reorganize]);

  // Dead-wiring warnings for the ⚠ toolbar chip; clicking a row selects + centers
  // the offending card (a stale ★final points at a gone card — fall back to fit-all).
  const problems = useMemo(
    () => problemsFor(graph, { signals: segment.signals, finalOutputId }),
    [graph, segment.signals, finalOutputId]
  );
  const onProblemClick = useCallback(
    (nodeId: string) => {
      const exists = graph.nodes.some((n) => n.id === nodeId);
      setSelected(new Set(exists ? [nodeId] : []));
      fitRef.current?.(exists ? [nodeId] : undefined);
    },
    [graph, setSelected]
  );

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
        onReorganize={graph.nodes.length > 1 ? onReorganize : null}
        onFitView={graph.nodes.length ? () => fitRef.current?.() : null}
        problems={problems}
        onProblemClick={onProblemClick}
        onUndo={undo}
        onRedo={redo}
        canUndo={canUndo}
        canRedo={canRedo}
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
            fitRef={fitRef}
            measureRef={measureRef}
            renderNode={renderNode}
          />
        </MinimizeContext.Provider>
      </div>
    </div>
  );
}
