import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  emptyGraph,
  normalizeGraph,
  connect,
  connectVideo,
  connectLoose,
  resolveDropPort,
  disconnect,
  removeNode,
  renameNode,
  rankedEdges,
} from "../../lib/graphModel";
import { emptyHistory, recordEdit, redoStep, undoStep } from "../../lib/graph/history";
import type { GraphHistory } from "../../lib/graph/history";
import { FLOW_GAPS, estimateCardSize, flowLayout } from "../../lib/graph/layout";
import type { LayoutRect } from "../../lib/graph/layout";
import { nodeParam } from "../../lib/nodeParams";
import type { Graph, GraphEdge, LyricLine, OutputSettings, Segment } from "../../lib/types";
import type { NodeCtx } from "./nodes/nodeProps";

// The animation editor "brain": graph state (the active composition's graph), the
// selection, the mutation handlers (connect / delete / minimize), and the assembled
// `ctx` handed to every node card. AnimationCanvas is then just the view (refs,
// fullscreen, layout). This is the seam to grow — new editor features (undo, node
// templates, …) add here without threading props through the component tree.

interface GraphEditorOpts {
  segment: Segment; // the host segment: time window + signals (the graph is NOT on it)
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
  commitGraph: (g: Graph) => void; // lifts the whole graph to the composition pool
  setFinalOutput?: NodeCtx["setFinalOutput"]; // mark/clear the composition's final output
}

export function useGraphEditor(opts: GraphEditorOpts) {
  const {
    segment,
    graph: rawGraph,
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
  } = opts;

  // A stable graph object: the composition's graph when present, else a fresh empty
  // graph. normalizeGraph migrates older saves so every fluid node carries the
  // current param ports — otherwise wiring those ports silently fails.
  const graph = useMemo(() => normalizeGraph(rawGraph || emptyGraph()), [rawGraph]);

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

  // Undo/redo (session-only, per segment — the editor remounts keyed by segment.id):
  // every commit records its PRE-EDIT snapshot; rapid commits coalesce into one step
  // (a slider drag = one Cmd+Z). Safe by reference — the mutation helpers are
  // strictly immutable, so old snapshots can never be edited under us.
  const historyRef = useRef(emptyHistory());
  // The stacks live in a ref (they must be readable synchronously inside a commit),
  // but their DEPTH is state: the toolbar's undo/redo buttons enable off it, and the
  // graph is controlled by the parent — a commit the parent ignores would otherwise
  // leave the buttons showing a stale history.
  const [histDepth, setHistDepth] = useState({ past: 0, future: 0 });
  const setHistory = useCallback((h: GraphHistory) => {
    historyRef.current = h;
    setHistDepth((d) =>
      d.past === h.past.length && d.future === h.future.length
        ? d
        : { past: h.past.length, future: h.future.length }
    );
  }, []);
  const applyUpdater = useCallback(
    (updater: (g: Graph) => Graph) => {
      const before = graphRef.current;
      const next = updater(before);
      if (next !== before) {
        setHistory(recordEdit(historyRef.current, before, Date.now()));
      }
      commitGraph(next);
    },
    [commitGraph, setHistory]
  );
  const undo = useCallback(() => {
    const r = undoStep(historyRef.current, graphRef.current);
    if (!r) return;
    setHistory(r.history);
    commitGraph(r.graph);
  }, [commitGraph, setHistory]);
  const redo = useCallback(() => {
    const r = redoStep(historyRef.current, graphRef.current);
    if (!r) return;
    setHistory(r.history);
    commitGraph(r.graph);
  }, [commitGraph, setHistory]);

  // Cmd/Ctrl+Z / Shift+Cmd+Z — skipped while typing in a field so text-editing
  // undo keeps working inside inputs, prompts, and the lyrics editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // One view: every non-output card is compact (name + preview; its body opens the
  // settings modal). Output alone renders full — its body IS the render preview.
  // `graph.view*` fields (v16 viewMode/viewOverrides, v20 cx/cy) are legacy and get
  // folded away by normalizeGraph; nothing here reads viewMode any more.

  // The set of cards rendered compact: every card EXCEPT output, whose body is the
  // live render preview and always shows full. renderAnimNode makes the same call at
  // the source; this set feeds the shared NodeFrame chrome.
  const minimized = useMemo(
    () => new Set(graph.nodes.filter((n) => n.type !== "output").map((n) => n.id)),
    [graph.nodes]
  );

  // ✨ arrange: lay the cards out along the data flow (flowLayout — columns left→right,
  // rows greedily untangled to reduce wire crossings) with the cards' MEASURED wrapper
  // sizes (exact) and the compact gaps. Writes straight to x/y.
  const reorganize = useCallback(
    (measured: Map<string, { w: number; h: number }>) => {
      applyUpdater((g) => {
        if (g.nodes.length < 2) return g;
        const rects: LayoutRect[] = g.nodes.map((n) => {
          const s = measured.get(n.id) || estimateCardSize(n.type, "compact");
          return { id: n.id, x: n.x, y: n.y, w: s.w, h: s.h };
        });
        const pos = flowLayout(rects, rankedEdges(g), FLOW_GAPS["compact"]);
        const nodes = g.nodes.map((n) => {
          const p = pos.get(n.id);
          return p && (p.x !== n.x || p.y !== n.y) ? { ...n, x: p.x, y: p.y } : n;
        });
        return nodes.some((n, i) => n !== g.nodes[i]) ? { ...g, nodes } : g;
      });
    },
    [applyUpdater]
  );

  // Accept a wire: a value source into a fluid param via connect(); anything else
  // (fluid/combine/points -> output or combine slot) as a plain video/points edge.
  const onConnect = useCallback(
    (srcId: string, srcPort: string, tgtId: string, tgtPort: string) => {
      applyUpdater((g) => {
        // A COMPACT card has one consolidated input dot standing in for every port,
        // so a direct drop can't know WHICH input is meant — park it gray/loose and
        // let the settings window assign it. Detailed cards keep direct-port wiring.
        if (minimized.has(tgtId)) return connectLoose(g, srcId, tgtId);
        const tgt = g.nodes.find((n) => n.id === tgtId);
        if (tgt && nodeParam(tgt.type, tgtPort)) {
          return connect(g, srcId, tgtId, tgtPort);
        }
        return connectVideo(g, srcId, srcPort, tgtId, tgtPort); // last-wins per port
      });
    },
    [applyUpdater, minimized]
  );

  // A wire released over a CARD (not a specific port): auto-assign when the
  // destination is unambiguous (output video / free combine slot / positions /
  // the only unbound param), else PARK it as a loose gray edge — the settings
  // window assigns it later.
  const onCardDrop = useCallback(
    (srcId: string, srcFlow: string, tgtId: string) => {
      applyUpdater((g) => {
        // Compact target → always park loose (see onConnect): the one input dot is
        // ambiguous, so the settings window does the assignment.
        if (minimized.has(tgtId)) return connectLoose(g, srcId, tgtId);
        const port = resolveDropPort(g, tgtId, srcFlow);
        if (!port) return connectLoose(g, srcId, tgtId);
        const tgt = g.nodes.find((n) => n.id === tgtId);
        if (tgt && nodeParam(tgt.type, port)) return connect(g, srcId, tgtId, port);
        return connectVideo(g, srcId, "out", tgtId, port);
      });
    },
    [applyUpdater, minimized]
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

  // Rename a card (node-level `name`); NodeFrame's title edit calls this. Node-level,
  // so it never touches outputHash → no re-render.
  const renameCard = useCallback(
    (id: string, name: string) => applyUpdater((g) => renameNode(g, id, name)),
    [applyUpdater]
  );

  // Provided to every NodeFrame's minimize/restore button + title rename; a stable
  // key feeds GraphCanvas so edges re-anchor on toggle.
  const minimizeCtx = useMemo(() => ({ minimized, rename: renameCard }), [minimized, renameCard]);
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
      exportSettings,
      assets,
      signals: segment.signals,
      lyricLines,
      onSaveLyricLines,
      lyricsKey,
      graph,
      groupClock,
      groupPlaying,
      segStart: segment.start,
      minimized, // the compact set -> renderAnimNode swaps in CompactCard
      finalOutputId, // which output the OutputNode shows as "final" (composition.outputId)
      setFinalOutput, // OutputNode marks itself final for this composition
      onGraphChange: applyUpdater,
      onDetach,
      onDeleteNode,
    }),
    [
      segment,
      stems,
      job,
      output,
      exportSettings,
      assets,
      lyricLines,
      onSaveLyricLines,
      lyricsKey,
      graph,
      groupClock,
      groupPlaying,
      minimized,
      finalOutputId,
      setFinalOutput,
      applyUpdater,
      onDetach,
      onDeleteNode,
    ]
  );

  return {
    // The DISPLAY graph (compact mode swaps in cx/cy) — what the canvas renders.
    // Commits flow back through `applyUpdater` (the translating wrapper below).
    graph,
    selected,
    setSelected,
    clearSelected,
    applyUpdater: applyUpdater,
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
    canUndo: histDepth.past > 0,
    canRedo: histDepth.future > 0,
  };
}
