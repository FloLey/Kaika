import { useCallback, useMemo, useRef, useState } from "react";
import {
  emptyGraph,
  normalizeGraph,
  connect,
  disconnect,
  removeNode,
  mkEdgeId,
} from "../../lib/graphModel";
import { nodeParam } from "../../lib/nodeParams";
import type { Graph, GraphEdge, OutputSettings, Segment } from "../../lib/types";
import type { NodeCtx } from "./nodes/nodeProps";

// The animation editor "brain": graph state (normalized from segment.graph), the
// selection, the mutation handlers (connect / delete / minimize), and the assembled
// `ctx` handed to every node card. AnimationCanvas is then just the view (refs,
// fullscreen, layout). This is the seam to grow — new editor features (undo, node
// templates, …) add here without threading props through the component tree.

interface GraphEditorOpts {
  segment: Segment;
  stems?: NodeCtx["stems"];
  job?: NodeCtx["job"];
  output?: OutputSettings | null;
  lyricLines?: unknown[];
  groupClock?: NodeCtx["groupClock"];
  groupPlaying?: boolean;
  commitGraph: (g: Graph) => void; // lifts the whole graph to segment.graph
  setFinalOutput?: NodeCtx["setFinalOutput"]; // mark/clear this segment's final output
}

export function useGraphEditor(opts: GraphEditorOpts) {
  const { segment, stems, job, output, lyricLines, groupClock, groupPlaying, commitGraph, setFinalOutput } = opts;

  // A stable graph object: segment.graph when present, else a fresh empty graph.
  // normalizeGraph migrates older saves so every fluid node carries the current
  // param ports — otherwise wiring those ports silently fails.
  const graph = useMemo(() => normalizeGraph(segment.graph || emptyGraph()), [segment.graph]);

  // Selection is a SET of ids so several cards (and/or an edge) can be active at
  // once — that's what makes "move a group in one go" possible. It holds node ids
  // and/or a single edge id; delete/group-move read the whole set.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const clearSelected = useCallback(() => setSelected(new Set()), []);
  const deselect = useCallback(
    (id: string) =>
      setSelected((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      }),
    []
  );

  // Stable updater: read the latest graph via a ref so the callback identity doesn't
  // change on every edit (keeps GraphCanvas/Palette from re-rendering each commit).
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const applyUpdater = useCallback(
    (updater: (g: Graph) => Graph) => commitGraph(updater(graphRef.current)),
    [commitGraph]
  );

  // Collapsed-to-header cards live ON the graph (`graph.minimized`) so they persist,
  // but the field is ignored by outputHash so toggling never busts the render cache.
  const minimized = useMemo(() => new Set<string>(graph.minimized || []), [graph.minimized]);
  const toggleMinimize = useCallback(
    (id: string) => {
      applyUpdater((g) => {
        const cur = new Set(g.minimized || []);
        if (cur.has(id)) cur.delete(id);
        else cur.add(id);
        return { ...g, minimized: [...cur] };
      });
    },
    [applyUpdater]
  );

  // Accept a wire: a value source into a fluid param via connect(); anything else
  // (fluid/combine/points -> output or combine slot) as a plain video/points edge.
  const onConnect = useCallback(
    (srcId: string, srcPort: string, tgtId: string, tgtPort: string) => {
      applyUpdater((g) => {
        const tgt = g.nodes.find((n) => n.id === tgtId);
        if (tgt && nodeParam(tgt.type, tgtPort)) {
          return connect(g, srcId, tgtId, tgtPort);
        }
        const edges = g.edges.filter((e) => !(e.target === tgtId && e.targetPort === tgtPort));
        edges.push({
          id: mkEdgeId(),
          source: srcId,
          sourcePort: srcPort,
          target: tgtId,
          targetPort: tgtPort,
        });
        return { ...g, edges };
      });
    },
    [applyUpdater]
  );

  const onEdgeDelete = useCallback(
    (edge: GraphEdge) => {
      applyUpdater((g) => {
        const tgt = g.nodes.find((n) => n.id === edge.target);
        if (tgt && nodeParam(tgt.type, edge.targetPort)) {
          return disconnect(g, edge.target, edge.targetPort);
        }
        return { ...g, edges: g.edges.filter((e) => e.id !== edge.id) };
      });
      deselect(edge.id);
    },
    [applyUpdater, deselect]
  );

  // Delete every selected id in ONE updater. Folding removeNode/disconnect over a
  // single graph (rather than calling per-item handlers) avoids each call reading a
  // stale graphRef within the same tick and clobbering the others' deletions.
  const onDeleteSelection = useCallback(
    (ids: string[]) => {
      if (!ids.length) return;
      applyUpdater((g) => {
        let ng = g;
        for (const id of ids) {
          if (ng.nodes.some((n) => n.id === id)) {
            ng = removeNode(ng, id);
            continue;
          }
          const edge = ng.edges.find((e) => e.id === id);
          if (!edge) continue;
          const tgt = ng.nodes.find((n) => n.id === edge.target);
          if (tgt && nodeParam(tgt.type, edge.targetPort)) {
            ng = disconnect(ng, edge.target, edge.targetPort);
          } else {
            ng = { ...ng, edges: ng.edges.filter((e) => e.id !== id) };
          }
        }
        return ng;
      });
      clearSelected();
    },
    [applyUpdater, clearSelected]
  );

  const allMinimized = graph.nodes.length > 0 && graph.nodes.every((n) => minimized.has(n.id));
  const toggleMinimizeAll = useCallback(() => {
    applyUpdater((g) => ({ ...g, minimized: allMinimized ? [] : g.nodes.map((n) => n.id) }));
  }, [applyUpdater, allMinimized]);

  // Provided to every NodeFrame's minimize/restore button; a stable key feeds
  // GraphCanvas so edges re-anchor on toggle.
  const minimizeCtx = useMemo(
    () => ({ minimized, toggle: toggleMinimize }),
    [minimized, toggleMinimize]
  );
  const minimizedKey = useMemo(() => [...minimized].sort().join(","), [minimized]);

  const onDetach = useCallback(
    (fluidId: string, key: string) => applyUpdater((g) => disconnect(g, fluidId, key)),
    [applyUpdater]
  );
  const onDeleteNode = useCallback(
    (id: string) => {
      applyUpdater((g) => removeNode(g, id));
      deselect(id);
    },
    [applyUpdater, deselect]
  );

  // Serialized once here so each OutputNode doesn't re-stringify the lyric lines
  // for its render key (they can be long, and there can be several outputs).
  const lyricsKey = useMemo(() => JSON.stringify(lyricLines || []), [lyricLines]);

  // The context handed to every node card (renderAnimNode). Memoized so cards can
  // be skipped via React.memo when nothing they read has changed — without this,
  // a fresh ctx identity per render forces every card to re-render on any edit.
  const ctx: NodeCtx = useMemo(
    () => ({
      segment,
      stems,
      job,
      output,
      signals: segment.signals,
      lyricLines,
      lyricsKey,
      graph,
      groupClock,
      groupPlaying,
      segStart: segment.start,
      minimized, // collapsed cards -> renderAnimNode swaps in MinimizedCard
      finalOutputId: segment.finalOutputId, // which output the OutputNode shows as "final"
      setFinalOutput, // OutputNode marks itself final for this segment
      onGraphChange: applyUpdater,
      onDetach,
      onDeleteNode,
    }),
    [
      segment,
      stems,
      job,
      output,
      lyricLines,
      lyricsKey,
      graph,
      groupClock,
      groupPlaying,
      minimized,
      setFinalOutput,
      applyUpdater,
      onDetach,
      onDeleteNode,
    ]
  );

  return {
    graph,
    selected,
    setSelected,
    clearSelected,
    applyUpdater,
    ctx,
    minimizeCtx,
    minimizedKey,
    allMinimized,
    toggleMinimizeAll,
    onConnect,
    onEdgeDelete,
    onDeleteSelection,
  };
}
