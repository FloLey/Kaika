import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import GraphCanvas from "./GraphCanvas.jsx";
import Palette from "./Palette.jsx";
import renderAnimNode from "./renderAnimNode.jsx";
import {
  emptyGraph, normalizeGraph, validate, connect, disconnect, removeNode, mkEdgeId, graphHash,
} from "../../lib/graphModel.js";
import { fluidParam } from "../../lib/fluidParams.js";
import * as api from "../../lib/api.js";

// 07 — the per-segment animation container. Owns render state (busy / url / error,
// selection) and bridges the graph (lifted to segment.graph) <-> GraphCanvas <->
// the /animate backend. Mount it keyed by segment.id so state resets per segment.
//
//   segment        — the active segment ({ id, start, end, signals, graph? })
//   stems, job     — project context (audio + spectrograms)
//   onGraphChange  — (graph) => void; commits the whole graph to segment.graph
export default function AnimationCanvas({
  segment, stems, job, output, groupClock, groupPlaying, onGraphChange: commitGraph,
}) {
  // A stable graph object: segment.graph when present, else a fresh empty graph.
  // normalizeGraph migrates older saves so every fluid node carries the current
  // param ports (e.g. r/g/b colour) — otherwise wiring those ports silently fails.
  const graph = useMemo(() => normalizeGraph(segment.graph || emptyGraph()), [segment.graph]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [selId, setSelId] = useState(null);

  const wrapRef = useRef(null);
  const viewRef = useRef(graph.view || { tx: 0, ty: 0, scale: 1 }); // session-only pan/zoom
  const reqId = useRef(0);

  // Apply a (graph) => graph updater and lift the result to segment.graph.
  const applyUpdater = useCallback(
    (updater) => commitGraph(updater(graph)),
    [commitGraph, graph]
  );

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

  // Accept a wire (compatibility already enforced by the canvas): a value source
  // into a fluid param via connect(); fluid -> output as a plain video edge.
  const onConnect = useCallback((srcId, srcPort, tgtId, tgtPort) => {
    applyUpdater((g) => {
      const tgt = g.nodes.find((n) => n.id === tgtId);
      if (tgt && tgt.type === "fluid" && fluidParam(tgtPort)) {
        return connect(g, srcId, tgtId, tgtPort);
      }
      const edges = g.edges.filter((e) => !(e.target === tgtId && e.targetPort === tgtPort));
      edges.push({ id: mkEdgeId(), source: srcId, sourcePort: srcPort, target: tgtId, targetPort: tgtPort });
      return { ...g, edges };
    });
  }, [applyUpdater]);

  const onEdgeDelete = useCallback((edge) => {
    applyUpdater((g) => {
      const tgt = g.nodes.find((n) => n.id === edge.target);
      if (tgt && tgt.type === "fluid" && fluidParam(edge.targetPort)) {
        return disconnect(g, edge.target, edge.targetPort);
      }
      return { ...g, edges: g.edges.filter((e) => e.id !== edge.id) };
    });
    setSelId(null);
  }, [applyUpdater]);

  const onNodeDelete = useCallback((node) => {
    applyUpdater((g) => removeNode(g, node.id));
    setSelId(null);
  }, [applyUpdater]);

  // A content hash of exactly the inputs that change the render: graph topology +
  // node data, segment bounds, and the defining fields of *referenced* signals.
  // It excludes pan/zoom/x-y and unreferenced signals, so the key only changes
  // when the output would — moving a node or editing an unrelated signal is a
  // no-op (see graphModel.graphHash).
  // The project output settings (size/quality/fps/background) also change the
  // rendered clip, so they ride in the render key (and the request) — editing
  // them re-renders, and the backend caches per (graph + output).
  const outputKey = JSON.stringify(output || {});
  const renderKey = useMemo(
    () => graphHash(graph, job, segment.start, segment.end, segment.signals) + outputKey,
    [graph, job, segment.start, segment.end, segment.signals, outputKey]
  );

  // Auto-render: whenever the render key changes, re-run the pipe (debounced).
  // Same pattern as FluidLab — a request-id guard drops stale responses so the
  // last edit always wins. Invalid/incomplete graphs (e.g. no output yet) skip
  // silently; only real backend failures surface an error.
  useEffect(() => {
    if (!validate(graph).ok) { setError(""); return undefined; }
    const id = ++reqId.current;
    setBusy(true);
    setError("");
    const t = setTimeout(async () => {
      try {
        const { url } = await api.renderGraph({
          job_id: job,
          segment: { start: segment.start, end: segment.end, signals: segment.signals },
          graph,
          output,
        });
        if (id !== reqId.current) return;        // a newer edit superseded us
        setVideoUrl(url);
      } catch (e) {
        if (id === reqId.current) setError(e.message || String(e));
      } finally {
        if (id === reqId.current) setBusy(false);
      }
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderKey]);

  const ctx = {
    segment, stems, job, output, videoUrl, busy, error,
    signals: segment.signals, graph,
    // the shared segment clock (Studio's refAudio) + transport state, so signal
    // pulse pads and the Output video all animate off one playhead.
    groupClock, groupPlaying, segStart: segment.start,
    onGraphChange: applyUpdater,
    onDetach: (fluidId, key) => applyUpdater((g) => disconnect(g, fluidId, key)),
    onDeleteNode: (id) => { applyUpdater((g) => removeNode(g, id)); setSelId(null); },
  };

  return (
    <div className="anim-wrap" ref={wrapRef}>
      <GraphCanvas
        graph={graph}
        onGraphChange={applyUpdater}
        onConnect={onConnect}
        onNodeDelete={onNodeDelete}
        onEdgeDelete={onEdgeDelete}
        selected={selId}
        onSelect={setSelId}
        onViewChange={(v) => { viewRef.current = v; }}
        renderNode={(node, helpers) => renderAnimNode(node, helpers, ctx)}
      />
      <Palette
        graph={graph}
        signals={segment.signals}
        centerGraph={centerGraph}
        onGraphChange={applyUpdater}
      />
    </div>
  );
}
