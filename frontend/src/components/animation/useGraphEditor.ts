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
} from "../../lib/graphModel";
import { emptyHistory, recordEdit, redoStep, undoStep } from "../../lib/graph/history";
import { FLOW_GAPS, estimateCardSize, flowLayout, resolveOverlaps, tighten } from "../../lib/graph/layout";
import type { LayoutRect } from "../../lib/graph/layout";
import { nodeParam } from "../../lib/nodeParams";
import type { Graph, GraphEdge, GraphNode, OutputSettings, Segment } from "../../lib/types";
import type { NodeCtx } from "./nodes/nodeProps";

// The animation editor "brain": graph state (normalized from segment.graph), the
// selection, the mutation handlers (connect / delete / minimize), and the assembled
// `ctx` handed to every node card. AnimationCanvas is then just the view (refs,
// fullscreen, layout). This is the seam to grow — new editor features (undo, node
// templates, …) add here without threading props through the component tree.

// ---- per-view positions (v20) --------------------------------------------------
// `x/y` is the DETAILED position (canonical), `cx/cy` the COMPACT one. In compact
// mode the canvas is handed a DISPLAY graph whose x/y are the compact coords, and
// commits are translated back (x/y writes land on cx/cy) — GraphCanvas stays
// position-agnostic. The WeakMap keeps display-node identity stable per real node,
// so React.memo'd cards skip re-renders exactly as they do in detailed mode.
const displayCache = new WeakMap<GraphNode, GraphNode>();
function displayNode(n: GraphNode): GraphNode {
  const dx = n.cx ?? n.x;
  const dy = n.cy ?? n.y;
  if (dx === n.x && dy === n.y) return n;
  let d = displayCache.get(n);
  if (!d) {
    d = { ...n, x: dx, y: dy };
    displayCache.set(n, d);
  }
  return d;
}
function toDisplay(g: Graph): Graph {
  const nodes = g.nodes.map(displayNode);
  return nodes.some((n, i) => n !== g.nodes[i]) ? { ...g, nodes } : g;
}

// The mode-switch derivation: give every card a position in the TARGET view without
// scrambling what the user arranged. Sizes are per-type ESTIMATES (the target mode
// isn't rendered yet); ✨ arrange re-runs the same passes with measured sizes.
//  → compact, first ever entry (no card has cx): tighten — scale the detailed
//    arrangement toward its center + de-overlap, the auto "keep them close".
//  → compact, later: seed missing cx/cy from x/y and de-overlap; an existing
//    compact layout only moves where cards would collide.
//  → detailed: de-overlap x/y — exactly the compact-built-pipeline fix; a clean
//    detailed layout is untouched (resolveOverlaps is a no-op without collisions).
function layoutForMode(nodes: GraphNode[], mode: "detailed" | "compact"): GraphNode[] {
  if (nodes.length < 2) return nodes;
  const rects: LayoutRect[] = nodes.map((n) => {
    const s = estimateCardSize(n.type, mode);
    const x = mode === "compact" ? n.cx ?? n.x : n.x;
    const y = mode === "compact" ? n.cy ?? n.y : n.y;
    return { id: n.id, x, y, w: s.w, h: s.h };
  });
  const firstCompactEntry = mode === "compact" && nodes.every((n) => n.cx == null);
  const pos = firstCompactEntry ? tighten(rects) : resolveOverlaps(rects);
  return nodes.map((n) => {
    const p = pos.get(n.id);
    if (!p) return n;
    if (mode === "compact") {
      return n.cx === p.x && n.cy === p.y ? n : { ...n, cx: p.x, cy: p.y };
    }
    return n.x === p.x && n.y === p.y ? n : { ...n, x: p.x, y: p.y };
  });
}

interface GraphEditorOpts {
  segment: Segment;
  stems?: NodeCtx["stems"];
  job?: NodeCtx["job"];
  output?: OutputSettings | null;
  lyricLines?: unknown[];
  onSaveLyricLines?: NodeCtx["onSaveLyricLines"];
  groupClock?: NodeCtx["groupClock"];
  groupPlaying?: boolean;
  commitGraph: (g: Graph) => void; // lifts the whole graph to segment.graph
  setFinalOutput?: NodeCtx["setFinalOutput"]; // mark/clear this segment's final output
}

export function useGraphEditor(opts: GraphEditorOpts) {
  const { segment, stems, job, output, lyricLines, onSaveLyricLines, groupClock, groupPlaying, commitGraph, setFinalOutput } = opts;

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

  // Undo/redo (session-only, per segment — the editor remounts keyed by segment.id):
  // every commit records its PRE-EDIT snapshot; rapid commits coalesce into one step
  // (a slider drag = one Cmd+Z). Safe by reference — the mutation helpers are
  // strictly immutable, so old snapshots can never be edited under us.
  const historyRef = useRef(emptyHistory());
  const applyUpdater = useCallback(
    (updater: (g: Graph) => Graph) => {
      const before = graphRef.current;
      const next = updater(before);
      if (next !== before) {
        historyRef.current = recordEdit(historyRef.current, before, Date.now());
      }
      commitGraph(next);
    },
    [commitGraph]
  );
  const undo = useCallback(() => {
    const r = undoStep(historyRef.current, graphRef.current);
    if (!r) return;
    historyRef.current = r.history;
    commitGraph(r.graph);
  }, [commitGraph]);
  const redo = useCallback(() => {
    const r = redoStep(historyRef.current, graphRef.current);
    if (!r) return;
    historyRef.current = r.history;
    commitGraph(r.graph);
  }, [commitGraph]);

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

  // View modes (v16): the canvas is globally "detailed" (classic full cards — the
  // default) or "compact" (name + preview), switched from the toolbar and persisted
  // as `graph.viewMode`. `graph.viewOverrides` lists cards displayed OPPOSITE to the
  // mode (▢/– per card); switching modes clears the overrides — a clean flip. Both
  // are top-level graph fields, so outputHash never sees them (toggling can't bust
  // the render cache). Downstream consumers (ctx.minimized, MinimizeContext,
  // renderAnimNode) keep receiving the derived COMPACT set, so their contract is
  // unchanged; `toggleMinimize` (kept name) flips override membership.
  const viewMode = graph.viewMode || "detailed";

  // What GraphCanvas renders: in compact mode, positions come from cx/cy (per-view
  // positions, v20). Everything the canvas does (drag, marquee, fit) just works in
  // display space; `applyDisplayUpdater` below translates its commits back.
  const displayGraph = useMemo(
    () => (viewMode === "compact" ? toDisplay(graph) : graph),
    [graph, viewMode]
  );

  // The updater handed to position-bearing callers (GraphCanvas, Palette adds, node
  // ctx): run the updater in DISPLAY space, then land position writes on the active
  // view's fields — in compact mode x/y edits become cx/cy and the detailed x/y is
  // restored from the pre-edit graph, so a compact drag never disturbs the detailed
  // layout. Nodes the updater didn't touch round-trip to the IDENTICAL real node
  // object (memo'd cards keep skipping). New nodes seed both views at the drop point;
  // the mode-switch pass de-overlaps the other view later.
  const applyDisplayUpdater = useCallback(
    (updater: (g: Graph) => Graph) => {
      applyUpdater((g) => {
        if ((g.viewMode || "detailed") !== "compact") return updater(g);
        const disp = toDisplay(g);
        const next = updater(disp);
        if (next === disp) return g;
        const prev = new Map(g.nodes.map((n) => [n.id, n]));
        return {
          ...next,
          nodes: next.nodes.map((dn) => {
            const p = prev.get(dn.id);
            if (p && dn === displayNode(p)) return p; // untouched — keep the real node
            return { ...dn, cx: dn.x, cy: dn.y, x: p ? p.x : dn.x, y: p ? p.y : dn.y };
          }),
        };
      });
    },
    [applyUpdater]
  );

  const overrides = useMemo(() => new Set<string>(graph.viewOverrides || []), [graph.viewOverrides]);
  // `output` never compacts — its body IS the live render preview — so it's excluded
  // here at the source (NodeFrame also hides its toggle) rather than special-cased
  // by every consumer of the compact set.
  const minimized = useMemo(
    () =>
      new Set(
        graph.nodes
          .filter(
            (n) =>
              n.type !== "output" &&
              (viewMode === "compact" ? !overrides.has(n.id) : overrides.has(n.id))
          )
          .map((n) => n.id)
      ),
    [graph.nodes, viewMode, overrides]
  );
  const toggleMinimize = useCallback(
    (id: string) => {
      applyUpdater((g) => {
        const cur = new Set(g.viewOverrides || []);
        if (cur.has(id)) cur.delete(id);
        else cur.add(id);
        return { ...g, viewOverrides: [...cur] };
      });
    },
    [applyUpdater]
  );
  // The toolbar mode switch: flip the whole canvas and drop the per-card exceptions.
  // `layoutForMode` derives the target view's positions (see its comment) — one
  // commit, one undo step, and only cards that would overlap actually move.
  const setViewMode = useCallback(
    (mode: "detailed" | "compact") => {
      applyUpdater((g) => ({
        ...g,
        nodes: layoutForMode(g.nodes, mode),
        viewMode: mode,
        viewOverrides: [],
      }));
    },
    [applyUpdater]
  );

  // ✨ arrange: lay the CURRENT view out along the data flow (flowLayout — columns
  // left→right, rows greedily untangled to reduce wire crossings) with the cards'
  // MEASURED wrapper sizes (exact, unlike the switch-time estimates) and per-mode
  // gaps — roomy in detailed, tighter in compact. Runs in display space, so the
  // translating wrapper lands the result on the right per-view fields.
  const reorganize = useCallback(
    (measured: Map<string, { w: number; h: number }>) => {
      applyDisplayUpdater((g) => {
        if (g.nodes.length < 2) return g;
        const mode = g.viewMode || "detailed";
        const rects: LayoutRect[] = g.nodes.map((n) => {
          const s = measured.get(n.id) || estimateCardSize(n.type, mode);
          return { id: n.id, x: n.x, y: n.y, w: s.w, h: s.h };
        });
        const pos = flowLayout(rects, g.edges, FLOW_GAPS[mode]);
        const nodes = g.nodes.map((n) => {
          const p = pos.get(n.id);
          return p && (p.x !== n.x || p.y !== n.y) ? { ...n, x: p.x, y: p.y } : n;
        });
        return nodes.some((n, i) => n !== g.nodes[i]) ? { ...g, nodes } : g;
      });
    },
    [applyDisplayUpdater]
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
  const minimizeCtx = useMemo(
    () => ({ minimized, toggle: toggleMinimize, mode: viewMode, rename: renameCard }),
    [minimized, toggleMinimize, viewMode, renameCard]
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
      onSaveLyricLines,
      lyricsKey,
      graph,
      groupClock,
      groupPlaying,
      segStart: segment.start,
      minimized, // the compact set -> renderAnimNode swaps in CompactCard
      finalOutputId: segment.finalOutputId, // which output the OutputNode shows as "final"
      setFinalOutput, // OutputNode marks itself final for this segment
      onGraphChange: applyDisplayUpdater,
      onDetach,
      onDeleteNode,
    }),
    [
      segment,
      stems,
      job,
      output,
      lyricLines,
      onSaveLyricLines,
      lyricsKey,
      graph,
      groupClock,
      groupPlaying,
      minimized,
      setFinalOutput,
      applyDisplayUpdater,
      onDetach,
      onDeleteNode,
    ]
  );

  return {
    // The DISPLAY graph (compact mode swaps in cx/cy) — what the canvas renders.
    // Commits flow back through `applyUpdater` (the translating wrapper below).
    graph: displayGraph,
    selected,
    setSelected,
    clearSelected,
    applyUpdater: applyDisplayUpdater,
    reorganize,
    ctx,
    minimizeCtx,
    minimizedKey,
    viewMode,
    setViewMode,
    onConnect,
    onCardDrop,
    onEdgeDelete,
    onDeleteSelection,
  };
}
