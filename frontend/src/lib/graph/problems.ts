// Graph PROBLEMS — dead wiring the executor renders silently (flat 0 / a frozen
// image / a black clip) with no error anywhere. The ⚠ chip on the canvas toolbar
// surfaces these; each rule mirrors a real debugging session:
//   · a gate/shaper/math with no input resolves to a constant 0 (the Playground
//     "slideshow never advances" bug),
//   · a wired port whose lo–hi range collapsed to zero width flattens its signal
//     (the BRILLER verse trigger 0–0 bug),
//   · an output with nothing wired can't render,
//   · a ★final mark pointing at a deleted card silently breaks the song export,
//   · a signal card whose segment signal was deleted reads flat 0.
// Pure + cheap (one pass over nodes/edges) so the editor can run it per commit.

import { LOOSE_PORT, portsOf } from "./core";
import { videoInput } from "./validate";
import type { Graph, GraphNode, Signal } from "../types";

export interface GraphProblem {
  nodeId: string; // the card to select/center when the row is clicked
  message: string;
}

// Value cards that RESOLVE THEIR INPUT: with nothing wired in they output flat 0.
// (lfo/noise/signal are generators — no input needed; scope is a monitor, but a
// dangling scope is a no-op rather than a wrong render, so it's not flagged.)
const NEEDS_VALUE_IN: Record<string, string> = {
  gate: "gate",
  shaper: "shaper",
  change: "change",
  math: "math",
};

interface SegmentLike {
  signals?: Signal[];
  finalOutputId?: string;
}

export function problemsFor(
  graph: Graph | null | undefined,
  segment?: SegmentLike
): GraphProblem[] {
  if (!graph || !Array.isArray(graph.nodes)) return [];
  const out: GraphProblem[] = [];
  const wiredTargets = new Set(
    (graph.edges || []).filter((e) => e.targetPort !== LOOSE_PORT).map((e) => e.target)
  );
  const sigIds = new Set((segment?.signals || []).map((s) => s.id));

  for (const n of graph.nodes as GraphNode[]) {
    // 1. input-resolving value card with nothing wired in -> constant 0.
    const label = NEEDS_VALUE_IN[n.type];
    if (label && !wiredTargets.has(n.id)) {
      out.push({
        nodeId: n.id,
        message: `${label} has no input wired — it outputs a flat 0`,
      });
    }

    // 2. a wired port whose lo–hi window is zero width -> the signal is flattened.
    const ports = portsOf(n);
    if (ports) {
      for (const [key, port] of Object.entries(ports)) {
        const b = port.binding;
        if (b && b.kind === "node" && b.hi === b.lo) {
          out.push({
            nodeId: n.id,
            message: `${n.type} “${key}” range is ${b.lo}–${b.hi} — the wired signal is flattened to a constant`,
          });
        }
      }
    }

    // 3. an output with no video input can't render.
    if (n.type === "output" && !videoInput(graph, n.id)) {
      out.push({ nodeId: n.id, message: "output has no input — wire a video producer into it" });
    }

    // 3b. montage dead wiring: no video inputs -> can't render; an unwired trigger
    // resolves to a constant 0 -> no cuts, only the first input ever plays.
    if (n.type === "montage") {
      const wired = (n.data.inputs || []).some((s) =>
        (graph.edges || []).some(
          (e) => e.target === n.id && e.targetPort === s.id && e.targetPort !== LOOSE_PORT
        )
      );
      if (!wired) {
        out.push({
          nodeId: n.id,
          message: "montage has no inputs — wire video cards into its slots",
        });
      }
      const trig = ports?.trigger?.binding;
      if (wired && (!trig || trig.kind !== "node")) {
        out.push({
          nodeId: n.id,
          message: "montage trigger has no signal — it never cuts, only the first input plays",
        });
      }
    }

    // 4. a signal card whose segment signal was deleted reads flat 0.
    if (n.type === "signal" && !sigIds.has(n.data.signalId)) {
      out.push({
        nodeId: n.id,
        message: "signal card references a deleted signal — it reads a flat 0",
      });
    }
  }

  // 5. a stale ★final mark: the song export renders THIS id per segment.
  const fin = segment?.finalOutputId;
  if (fin && !(graph.nodes as GraphNode[]).some((n) => n.id === fin)) {
    out.push({
      nodeId: fin,
      message: "the ★ final-output mark points at a deleted card — re-mark an output",
    });
  }
  return out;
}
