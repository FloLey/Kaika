import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  emptyGraph,
  normalizeGraph,
  connect,
  connectVideo,
  connectLoose,
  resolveDropPort,
  wirePort,
  disconnect,
  removeNode,
  renameNode,
  rankedEdges,
  copySelection,
  pasteClipboard,
  writeClipboard,
  readClipboard,
  nextPasteOffset,
} from "../../lib/graphModel";
import { emptyHistory, recordEdit, redoStep, undoStep } from "../../lib/graph/history";
import type { GraphHistory } from "../../lib/graph/history";
import { FLOW_GAPS, estimateCardSize, flowLayout } from "../../lib/graph/layout";
import type { LayoutRect } from "../../lib/graph/layout";
import { nodeParam } from "../../lib/nodeParams";
import { isNext } from "../../lib/uiFlag";
import { chromeFor } from "./nodes/registry";
import { cardInputs } from "./nodeInputs";
import { planDrop } from "./dropPlan";
import type { DropCandidate, DropPlan } from "./dropPlan";
import type {
  Graph,
  GraphEdge,
  LyricLine,
  OutputSettings,
  PortFlow,
  Segment,
} from "../../lib/types";
import type { NodeCtx } from "./nodes/nodeProps";

// Where a wire was released, in the canvas's own screen-space coordinates (the space
// `.gc-hint` and the wire overlay already use), so the menu opens under the cursor.
export interface DropPoint {
  x: number;
  y: number;
}

// An open port-drop menu: which wire is being landed, where, and on what.
export interface DropMenu extends DropPoint {
  srcId: string;
  tgtId: string;
  flow: PortFlow;
  candidates: DropCandidate[];
  dynamic?: Extract<DropPlan, { kind: "menu" }>["dynamic"];
}

// The animation editor "brain": graph state (the active composition's graph), the
// selection, the mutation handlers (connect / delete / minimize), and the assembled
// `ctx` handed to every node card. AnimationCanvas is then just the view (refs,
// fullscreen, layout). This is the seam to grow — new editor features (undo, node
// templates, …) add here without threading props through the component tree.

interface GraphEditorOpts {
  segment: Segment; // the host segment: time window + signals (the graph is NOT on it)
  graph?: Graph | null; // the active composition's graph (null = none built yet)
  finalOutputId?: string; // the composition's ★-final output mark
  compositions?: NodeCtx["compositions"]; // the pool (montage extracts reference into it)
  compositionId?: NodeCtx["compositionId"]; // the composition this editor edits
  refCounts?: NodeCtx["refCounts"]; // "used ×N" per composition
  updateCompositions?: NodeCtx["updateCompositions"]; // pool writes ("pick a video" → leaf)
  enterExtract?: NodeCtx["enterExtract"]; // breadcrumb descent into an extract's child
  enterMontage?: NodeCtx["enterMontage"]; // a montage compact body opens the editor
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

  // Copy/paste of the selected card group — INCLUDING across segments: the
  // clipboard is module state (lib/graph/clipboard), so it survives this editor
  // remounting when the user navigates to another segment and pastes there.
  // `canPaste` is local state because a copy in ANOTHER segment's editor can't
  // notify this one — it re-arms on every copy here and on mount (readClipboard).
  const [canPaste, setCanPaste] = useState(() => readClipboard() !== null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const copy = useCallback(() => {
    const clip = copySelection(graphRef.current, selectedRef.current);
    if (!clip) return;
    writeClipboard(clip);
    setCanPaste(true);
  }, []);
  const paste = useCallback(() => {
    const clip = readClipboard();
    if (!clip) return;
    // One updater + selecting the new ids: the pasted group lands selected, so
    // dragging it into place is the very next gesture.
    let ids: string[] = [];
    applyUpdater((g) => {
      const r = pasteClipboard(g, clip, { offset: nextPasteOffset(), signals: segment.signals });
      ids = r.ids;
      return r.graph;
    });
    if (ids.length) setSelected(new Set(ids));
  }, [applyUpdater, segment.signals]);

  // Cmd/Ctrl+Z / Shift+Cmd+Z, Cmd/Ctrl+C / Cmd/Ctrl+V — skipped while typing in a
  // field so text editing keeps its own shortcuts, and copy defers to a real text
  // selection (copying a title must not silently become "copy the cards").
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key !== "z" && key !== "c" && key !== "v") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (key === "c") {
        if (!selectedRef.current.size || document.getSelection()?.toString()) return;
        e.preventDefault();
        copy();
        return;
      }
      e.preventDefault();
      paste();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, copy, paste]);

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

  // ?ui=next — resolve a drop onto a COMPACT card at the drop point instead of
  // parking it. `null` = no menu open. Held here rather than in the canvas because
  // the decision is about the graph, not about pixels; the canvas only places it.
  const [dropMenu, setDropMenu] = useState<DropMenu | null>(null);
  const closeDropMenu = useCallback(() => setDropMenu(null), []);

  // The shared compact-drop path. Both wire gestures (onto the consolidated input
  // dot, and onto the card body) end up here, so they can't behave differently.
  const compactDrop = useCallback(
    (srcId: string, tgtId: string, at?: DropPoint) => {
      const g = graphRef.current;
      const src = g.nodes.find((n) => n.id === srcId);
      if (!src) return;
      const flow = chromeFor(src.type).outFlow as PortFlow;
      const plan = planDrop(g, flow, tgtId);
      if (plan.kind === "connect") {
        applyUpdater((gg) => wirePort(gg, srcId, "out", tgtId, plan.portId));
        return;
      }
      if (plan.kind === "park" || !at) {
        applyUpdater((gg) => connectLoose(gg, srcId, tgtId));
        return;
      }
      setDropMenu({
        srcId,
        tgtId,
        flow,
        ...at,
        candidates: plan.candidates,
        dynamic: plan.dynamic,
      });
    },
    [applyUpdater]
  );

  // Take one entry from the open drop menu.
  const pickDropPort = useCallback(
    (portId: string) => {
      const m = dropMenu;
      if (!m) return;
      applyUpdater((g) => wirePort(g, m.srcId, "out", m.tgtId, portId));
      setDropMenu(null);
    },
    [applyUpdater, dropMenu]
  );

  // "+ new layer/input": grow the card's dynamic group and land the wire on the row
  // that just appeared. Reading the new port back off `cardInputs` (rather than
  // guessing an id) keeps this working for any dynamic group the registry grows.
  const addDropPort = useCallback(() => {
    const m = dropMenu;
    if (!m?.dynamic) return;
    const dyn = m.dynamic;
    applyUpdater((g) => {
      const g2 = dyn.add(g, m.tgtId);
      const node = g2.nodes.find((n) => n.id === m.tgtId);
      if (!node) return g2;
      const rows = cardInputs(node).inputs.filter((i) => i.flow === m.flow);
      const fresh = rows[rows.length - 1];
      return fresh ? wirePort(g2, m.srcId, "out", m.tgtId, fresh.portId) : g2;
    });
    setDropMenu(null);
  }, [applyUpdater, dropMenu]);

  // "park for later": the pre-flag behaviour, now an explicit choice.
  const parkDrop = useCallback(() => {
    const m = dropMenu;
    if (!m) return;
    applyUpdater((g) => connectLoose(g, m.srcId, m.tgtId));
    setDropMenu(null);
  }, [applyUpdater, dropMenu]);

  // Accept a wire: a value source into a fluid param via connect(); anything else
  // (fluid/combine/points -> output or combine slot) as a plain video/points edge.
  const onConnect = useCallback(
    (srcId: string, srcPort: string, tgtId: string, tgtPort: string, at?: DropPoint) => {
      // A COMPACT card has one consolidated input dot standing in for every port, so
      // a direct drop can't know WHICH input is meant. Under ?ui=next we resolve it
      // at the drop point; otherwise it parks gray/loose for the settings window.
      if (minimized.has(tgtId)) {
        if (isNext()) return compactDrop(srcId, tgtId, at);
        return applyUpdater((g) => connectLoose(g, srcId, tgtId));
      }
      applyUpdater((g) => {
        const tgt = g.nodes.find((n) => n.id === tgtId);
        if (tgt && nodeParam(tgt.type, tgtPort)) {
          return connect(g, srcId, tgtId, tgtPort);
        }
        return connectVideo(g, srcId, srcPort, tgtId, tgtPort); // last-wins per port
      });
    },
    [applyUpdater, compactDrop, minimized]
  );

  // A wire released over a CARD (not a specific port): auto-assign when the
  // destination is unambiguous (output video / free combine slot / positions /
  // the only unbound param), else PARK it as a loose gray edge — the settings
  // window assigns it later.
  const onCardDrop = useCallback(
    (srcId: string, srcFlow: string, tgtId: string, at?: DropPoint) => {
      if (minimized.has(tgtId)) {
        if (isNext()) return compactDrop(srcId, tgtId, at);
        return applyUpdater((g) => connectLoose(g, srcId, tgtId));
      }
      applyUpdater((g) => {
        const port = resolveDropPort(g, tgtId, srcFlow);
        if (!port) return connectLoose(g, srcId, tgtId);
        const tgt = g.nodes.find((n) => n.id === tgtId);
        if (tgt && nodeParam(tgt.type, port)) return connect(g, srcId, tgtId, port);
        return connectVideo(g, srcId, "out", tgtId, port);
      });
    },
    [applyUpdater, compactDrop, minimized]
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
    // The graph the canvas renders — one coordinate set since the detailed view was
    // removed (there is no display/canonical translation any more). Commits flow
    // back through `applyUpdater`.
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
    dropMenu,
    pickDropPort,
    addDropPort,
    parkDrop,
    closeDropMenu,
    onEdgeDelete,
    onDeleteSelection,
    undo,
    redo,
    canUndo: histDepth.past > 0,
    canRedo: histDepth.future > 0,
    copy,
    paste,
    canCopy: [...selected].some((id) => graph.nodes.some((n) => n.id === id)),
    canPaste,
  };
}
