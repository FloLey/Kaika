import { useEffect, useRef, useState } from "react";
import { resolveCurve } from "../../../lib/api";
import { jobIdOf } from "./nodeProps";
import type { NodeCtx } from "./nodeProps";

// Resolve a value node's ACTUAL 0..1 curve from the backend (the same `/resolve` the
// Scope uses) so a generator card's preview matches exactly what the Scope and the
// render produce — instead of a local JS approximation that can drift (e.g. noise uses
// a different PRNG on each side). `depKey` should serialize whatever changes the curve
// — use `upstreamKey(graph, nodeId, signals)` (graphModel) so an upstream edit
// refetches but an unrelated card's edit doesn't.
export function useResolvedCurve(
  ctx: NodeCtx | undefined,
  nodeId: string,
  depKey: string
): { curve: number[]; loading: boolean } {
  const [curve, setCurve] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const seg = ctx?.segment;
  const segStart = seg?.start ?? 0;
  const segEnd = seg?.end ?? 0;
  const jobId = jobIdOf(ctx?.job);
  const graph = ctx?.graph;
  // Refs so the debounced call posts the LATEST graph/signals even though the effect
  // is keyed on depKey — a closure over `graph` would freeze the render where depKey
  // last changed and resolve against a stale snapshot.
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const signalsRef = useRef(seg?.signals);
  signalsRef.current = seg?.signals;

  useEffect(() => {
    if (!graph || !jobId || segEnd - segStart <= 0.001) {
      setLoading(false);
      setCurve([]);
      return undefined;
    }
    setLoading(true);
    const t = setTimeout(() => {
      resolveCurve({
        job_id: jobId,
        segment: { start: segStart, end: segEnd, signals: signalsRef.current },
        graph: graphRef.current,
        node_id: nodeId,
      })
        .then((d) => {
          setCurve(d.curve || []);
          setLoading(false);
        })
        .catch(() => {
          setCurve([]);
          setLoading(false);
        });
    }, 200);
    return () => clearTimeout(t);
    // Deliberate: refetch on `depKey` (the upstream signature) + window, not on every
    // graph object identity; the refs above keep the posted graph fresh regardless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depKey, jobId, nodeId, segStart, segEnd]);

  return { curve, loading };
}
