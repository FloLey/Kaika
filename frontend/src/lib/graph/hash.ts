// Per-output subgraph hashing (01 §3.6): gates redundant render POSTs for ONE
// output. The backend computes the authoritative cache-path hash; this only needs
// to match itself between renders.

import { outputContributing } from "./validate";
import type { Graph, Signal } from "../types";

// ---- hashing (01 §3.6) -------------------------------------------------------

// Defining fields of a referenced signal that change the render output.
const SIGNAL_HASH_FIELDS = [
  "stemKey",
  "minHz",
  "maxHz",
  "feature",
  "attack",
  "release",
  "invert",
  "gamma",
  "gain",
  "offset",
  "threshold",
];

// Stable JSON: sorted keys, recursive. Callers hand it an already-canonicalized
// object (no x/y/view).
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

// FNV-1a over a string -> 8-hex. Only needs to match itself between renders (the
// backend computes the authoritative filename hash); this gates redundant POSTs.
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// Per-output subgraph hash: gates redundant POSTs for ONE output. Covers the WHOLE
// contributing video DAG upstream of `outputId` (fluids, combines, output
// pass-throughs, value/signal nodes) + the edges among them + bounds + jobId. So
// editing pipeline B never busts A's cache; moving a node / unrelated signal is a
// no-op. Mirrors backend `output_hash`.
export function outputHash(
  graph: Graph,
  outputId: string,
  jobId: string | null | undefined,
  start: number | null | undefined,
  end: number | null | undefined,
  signals: Signal[] | undefined
): string {
  const contributing = outputContributing(graph, outputId);
  const sigById = new Map((signals || []).map((s) => [s.id, s]));
  const referenced: Record<string, unknown> = {};
  const nodes = (graph.nodes || [])
    .filter((n) => contributing.has(n.id))
    .map((n) => {
      if (n.type === "signal") {
        const sig = sigById.get(n.data.signalId);
        if (sig) {
          referenced[n.data.signalId] = Object.fromEntries(
            SIGNAL_HASH_FIELDS.map((k) => [k, (sig as unknown as Record<string, unknown>)[k]])
          );
        }
      }
      return { id: n.id, type: n.type, data: n.data };
    });
  const canon = {
    outputId,
    nodes,
    edges: (graph.edges || [])
      .filter((e) => contributing.has(e.source) && contributing.has(e.target))
      .map((e) => ({
        source: e.source,
        sourcePort: e.sourcePort,
        target: e.target,
        targetPort: e.targetPort,
      })),
    jobId: jobId ?? null,
    start: start ?? null,
    end: end ?? null,
    signals: referenced,
  };
  return fnv1a(stableStringify(canon));
}
