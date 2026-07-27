import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import GraphCanvas from "./GraphCanvas";
import MontageEditor from "./MontageEditor";
import Palette from "./Palette";
import PortDropMenu from "./PortDropMenu";
import NodeInspector from "./NodeInspector";
import CommandPalette from "../next/CommandPalette";
import { buildCommandItems } from "../next/commandItems";
import type { CommandItem } from "../next/commandItems";
import { planDrop } from "./dropPlan";
import renderAnimNode from "./renderAnimNode";
import { defaultCardName } from "./nodeInputs";
import { chromeFor } from "./nodes/registry";
import { MinimizeContext } from "./nodes/minimizeContext";
import { useGraphEditor } from "./useGraphEditor";
import { problemsFor, wirePort } from "../../lib/graphModel";
import type { View } from "./usePanZoom";
import type {
  Graph,
  GraphNode,
  LyricLine,
  OutputSettings,
  PortFlow,
  Segment,
} from "../../lib/types";
import type { NodeCtx, NodeHelpers } from "./nodes/nodeProps";

interface AnimationCanvasProps {
  segment: Segment;
  graph?: Graph | null; // the active composition's graph (null = none built yet)
  finalOutputId?: string; // the composition's ★-final output mark
  compositions?: NodeCtx["compositions"]; // the pool (montage extracts reference into it)
  compositionId?: NodeCtx["compositionId"]; // the composition this canvas edits
  refCounts?: NodeCtx["refCounts"]; // "used ×N" per composition
  updateCompositions?: NodeCtx["updateCompositions"]; // pool writes ("pick a video" → leaf)
  enterExtract?: NodeCtx["enterExtract"]; // breadcrumb descent into an extract's child
  enterMontage?: NodeCtx["enterMontage"]; // a montage compact body opens the editor
  // When set (a "montage" breadcrumb frame), the stage renders the MONTAGE EDITOR
  // for this node instead of the graph canvas — same graph state, richer surface.
  montageEditorNodeId?: string;
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
  // ⌘K reach beyond this composition: the project's segments and how to
  // switch. Optional — without them the palette still adds cards and jumps to them.
  segments?: Segment[];
  onSelectSegment?: (id: string) => void;
}

// A card's display name: what the user named it, else its type's palette title —
// the same fallback NodeFrame renders in the title bar.
const cardName = (graph: Graph, id: string): string => {
  const n = graph.nodes.find((x) => x.id === id);
  return n ? (n.name ?? chromeFor(n.type).title) : id;
};

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
  compositions,
  compositionId,
  refCounts,
  updateCompositions,
  enterExtract,
  enterMontage,
  montageEditorNodeId,
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
  segments,
  onSelectSegment,
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
    dropMenu,
    pickDropPort,
    addDropPort,
    parkDrop,
    closeDropMenu,
    onEdgeDelete,
    onDeleteSelection,
    undo,
    redo,
    canUndo,
    canRedo,
    copy,
    paste,
    canCopy,
    canPaste,
  } = useGraphEditor({
    segment,
    graph: compGraph,
    finalOutputId,
    compositions,
    compositionId,
    refCounts,
    updateCompositions,
    enterExtract,
    enterMontage,
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

  // --- ⌘K ---------------------------------------------------------------------
  // 35 card types behind seven category dropdowns with no search; and nothing that
  // jumps to a card or a segment by name. One box does all three.
  const [cmdOpen, setCmdOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      setCmdOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const commandItems = useMemo(
    () =>
      cmdOpen
        ? buildCommandItems({
            graph,
            segments,
            activeSegmentId: segment.id,
            signals: segment.signals,
          })
        : [],
    [cmdOpen, graph, segments, segment.id, segment.signals]
  );

  // The lone selected card, when it could feed something — what an added card wires
  // itself to. One selection only: guessing a source out of several is how you get a
  // wire you did not ask for.
  const wireFrom = useMemo(() => {
    const ids = [...selected].filter((id) => graph.nodes.some((n) => n.id === id));
    if (ids.length !== 1) return null;
    const node = graph.nodes.find((n) => n.id === ids[0])!;
    return { id: node.id, flow: chromeFor(node.type).outFlow as PortFlow };
  }, [selected, graph]);

  const runCommand = useCallback(
    (item: CommandItem) => {
      setCmdOpen(false);
      if (item.kind === "segment") return onSelectSegment?.(item.segmentId);
      if (item.kind === "card") {
        setSelected(new Set([item.nodeId]));
        fitRef.current?.([item.nodeId]);
        return;
      }
      // Add: place it where a toolbar add would, name it the same way, then wire it
      // from the selection if — and only if — the port is unambiguous. That is the
      // same `planDrop` the canvas drop menu uses, so "obvious enough to do silently"
      // means one thing in this editor, not two.
      const { x, y } = centerGraph();
      let addedId: string | null = null;
      applyUpdater((g) => {
        const node = item.factory(x, y);
        addedId = node.id;
        const withNode = {
          ...g,
          nodes: [...g.nodes, { ...node, name: node.name ?? defaultCardName(g, node.type) }],
        };
        if (!wireFrom) return withNode;
        const plan = planDrop(withNode, wireFrom.flow, node.id);
        return plan.kind === "connect"
          ? wirePort(withNode, wireFrom.id, "out", node.id, plan.portId)
          : withNode;
      });
      if (addedId) setSelected(new Set([addedId]));
    },
    [applyUpdater, centerGraph, onSelectSegment, setSelected, wireFrom]
  );

  // The card being edited, shown in a dock BESIDE the canvas rather than a modal over
  // it. Exactly one selected node qualifies: with several selected there is no single
  // card to show, and with none the dock says so.
  const inspected = useMemo(() => {
    const ids = [...selected].filter((id) => graph.nodes.some((n) => n.id === id));
    return ids.length === 1 ? (graph.nodes.find((n) => n.id === ids[0]) ?? null) : null;
  }, [selected, graph]);
  const selectedCount = useMemo(
    () => [...selected].filter((id) => graph.nodes.some((n) => n.id === id)).length,
    [selected, graph]
  );

  // Portalled, so it rides above whichever surface the stage is showing.
  const commandPalette = cmdOpen ? (
    <CommandPalette
      items={commandItems}
      onRun={runCommand}
      onClose={() => setCmdOpen(false)}
      wireHint={wireFrom ? `from ${cardName(graph, wireFrom.id)}` : undefined}
    />
  ) : null;

  // A "montage" breadcrumb frame: the stage IS the montage editor (strip + live
  // view + wiring rail). Same graph state and ctx as the canvas — only the surface
  // changes; Studio pops the frame if the node vanishes.
  const editorNode = montageEditorNodeId
    ? graph.nodes.find((n) => n.id === montageEditorNodeId && n.type === "montage")
    : undefined;
  if (editorNode) {
    return (
      <div className="anim-wrap">
        <MontageEditor node={editorNode} ctx={ctx} onGraphChange={applyUpdater} />
        {commandPalette}
      </div>
    );
  }

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
        onCopy={copy}
        onPaste={paste}
        canCopy={canCopy}
        canPaste={canPaste}
      />
      <div className="anim-stage">
        {/* The canvas gets its own positioning context so the dock can sit beside
            it: .gc-root is inset-0, and without this it would fill the dock too.
            `wrapRef` measures THIS, so a new card still lands in the middle of what
            you can actually see. */}
        <div className="anim-canvas-col" ref={wrapRef}>
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
          {/* The dropped wire picks its port here, over the canvas, instead
            of parking gray and sending you to the settings window. Placed in the
            stage (not inside GraphCanvas) because it lives in the stage's coordinate
            space, which is the canvas root's own: .gc-root is inset-0 inside it. */}
          {dropMenu && (
            <PortDropMenu
              x={dropMenu.x}
              y={dropMenu.y}
              sourceName={cardName(graph, dropMenu.srcId)}
              targetName={cardName(graph, dropMenu.tgtId)}
              candidates={dropMenu.candidates}
              nameOf={(id) => cardName(graph, id)}
              dynamicLabel={dropMenu.dynamic?.label}
              onPick={pickDropPort}
              onAddDynamic={addDropPort}
              onPark={parkDrop}
              onCancel={closeDropMenu}
            />
          )}
        </div>

        {/* The inspector, docked. `NodeInspector` is the same component the modal
            renders — OutputNode still opens that modal — so the two arrangements show
            identical contents; the difference is that here the graph it edits stays on
            screen, and moving to another card swaps the panel instead of closing and
            reopening a window. */}
        <aside className="anim-dock">
          {inspected ? (
            <NodeInspector
              node={inspected}
              ctx={ctx}
              onGraphChange={applyUpdater}
              onDetach={ctx.onDetach}
              className="node-settings anim-dock-panel"
            />
          ) : (
            <div className="anim-dock-empty">
              {selectedCount > 1
                ? `${selectedCount} cards selected — pick one to edit it`
                : "select a card to edit it"}
            </div>
          )}
        </aside>
      </div>
      {commandPalette}
    </div>
  );
}
