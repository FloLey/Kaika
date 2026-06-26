import { useCallback, useMemo, useRef, useState } from "react";
import {
  emptyGraph,
  normalizeGraph,
  connect,
  disconnect,
  removeNode,
  mkEdgeId,
} from "../../lib/graphModel";
import { fluidParam } from "../../lib/fluidParams.js";
import type { Graph, GraphEdge, GraphNode, OutputSettings } from "../../lib/types";
import type { NodeCtx, SignalDef } from "./nodes/nodeProps";

// The animation editor "brain": graph state (normalized from segment.graph), the
// selection, the mutation handlers (connect / delete / minimize), and the assembled
// `ctx` handed to every node card. AnimationCanvas is then just the view (refs,
// fullscreen, layout). This is the seam to grow — new editor features (undo, node
// templates, …) add here without threading props through the component tree.

interface GraphEditorOpts {
  segment: NodeCtx["segment"] & { graph?: Graph };
  stems?: NodeCtx["stems"];
  job?: NodeCtx["job"];
  output?: OutputSettings | null;
  groupClock?: NodeCtx["groupClock"];
  groupPlaying?: boolean;
  commitGraph: (g: Graph) => void; // lifts the whole graph to segment.graph
}

export function useGraphEditor(opts: GraphEditorOpts) {
  const { segment, stems, job, output, groupClock, groupPlaying, commitGraph } = opts;

  // A stable graph object: segment.graph when present, else a fresh empty graph.
  // normalizeGraph migrates older saves so every fluid node carries the current
  // param ports — otherwise wiring those ports silently fails.
  const graph = useMemo(
    () => normalizeGraph((segment.graph as Graph) || emptyGraph()),
    [segment.graph]
  );
  const [selId, setSelId] = useState<string | null>(null);

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
        if (tgt && tgt.type === "fluid" && fluidParam(tgtPort)) {
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
        if (tgt && tgt.type === "fluid" && fluidParam(edge.targetPort)) {
          return disconnect(g, edge.target, edge.targetPort);
        }
        return { ...g, edges: g.edges.filter((e) => e.id !== edge.id) };
      });
      setSelId(null);
    },
    [applyUpdater]
  );

  const onNodeDelete = useCallback(
    (node: GraphNode) => {
      applyUpdater((g) => removeNode(g, node.id));
      setSelId(null);
    },
    [applyUpdater]
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

  // The context handed to every node card (renderAnimNode).
  const ctx: NodeCtx = {
    segment,
    stems,
    job,
    output,
    signals: segment.signals as SignalDef[] | undefined,
    graph,
    groupClock,
    groupPlaying,
    segStart: segment.start,
    minimized, // collapsed cards -> renderAnimNode swaps in MinimizedCard
    onGraphChange: applyUpdater,
    onDetach: (fluidId: string, key: string) => applyUpdater((g) => disconnect(g, fluidId, key)),
    onDeleteNode: (id: string) => {
      applyUpdater((g) => removeNode(g, id));
      setSelId(null);
    },
  };

  return {
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
  };
}
