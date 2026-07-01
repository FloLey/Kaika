import { useEffect, useState } from "react";
import { resolveCurve } from "../../../lib/api";
import type { NodeCtx } from "./nodeProps";

// Resolve a value node's ACTUAL 0..1 curve from the backend (the same `/resolve` the
// Scope uses) so a generator card's preview matches exactly what the Scope and the
// render produce — instead of a local JS approximation that can drift (e.g. noise uses
// a different PRNG on each side). `depKey` should serialize whatever changes the curve
// (the node's own data), so it refetches on edit but not on unrelated graph changes.
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
  const job = ctx?.job;
  const jobId = typeof job === "string" ? job : (job as { job_id?: string } | undefined)?.job_id;
  const graph = ctx?.graph;

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
        segment: { start: segStart, end: segEnd, signals: seg?.signals },
        graph,
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
    // Deliberate: refetch on the serialized `depKey` (the node's data) + window, not on
    // every graph object identity. `graph` is read fresh inside the debounced call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depKey, jobId, nodeId, segStart, segEnd]);

  return { curve, loading };
}
