import { useEffect, useState } from "react";
import { resolvePoints } from "../../../lib/api";
import type { NodeCtx } from "./nodeProps";

// Resolve a points node's REAL positions from the backend (`/resolve-points`, the
// points twin of `/resolve`) so animate-points / merge-points — whose positions depend
// on upstream + transforms — can show a live scatter. `depKey` should serialize the
// contributing graph so it refetches on any upstream edit. Debounced like
// useResolvedCurve.
export function useResolvedPoints(
  ctx: NodeCtx | undefined,
  nodeId: string,
  depKey: string
): { points: [number, number][]; loading: boolean } {
  const [points, setPoints] = useState<[number, number][]>([]);
  const [loading, setLoading] = useState(true);
  const seg = ctx?.segment;
  const job = ctx?.job;
  const jobId = typeof job === "string" ? job : (job as { job_id?: string } | undefined)?.job_id;
  const graph = ctx?.graph;

  useEffect(() => {
    if (!graph || !jobId) {
      setLoading(false);
      setPoints([]);
      return undefined;
    }
    setLoading(true);
    const t = setTimeout(() => {
      resolvePoints({
        job_id: jobId,
        segment: { start: seg?.start ?? 0, end: seg?.end ?? 0, signals: seg?.signals },
        graph,
        node_id: nodeId,
      })
        .then((d) => {
          setPoints(d.points || []);
          setLoading(false);
        })
        .catch(() => {
          setPoints([]);
          setLoading(false);
        });
    }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depKey, jobId, nodeId]);

  return { points, loading };
}
