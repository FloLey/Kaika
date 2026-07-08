import { useEffect, useRef, useState } from "react";
import { resolvePoints } from "../../../lib/api";
import { jobIdOf } from "./nodeProps";
import type { NodeCtx } from "./nodeProps";

// Resolve a points node's REAL positions from the backend (`/resolve-points`, the
// points twin of `/resolve`) so animate-points / merge-points — whose positions depend
// on upstream + transforms — can show a live scatter. `depKey` should serialize the
// contributing graph so it refetches on any upstream edit. Debounced like
// useResolvedCurve, and structured identically to it (same refs, same deps).
export function useResolvedPoints(
  ctx: NodeCtx | undefined,
  nodeId: string,
  depKey: string
): { points: [number, number][]; loading: boolean } {
  const [points, setPoints] = useState<[number, number][]>([]);
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
    if (!graph || !jobId) {
      setLoading(false);
      setPoints([]);
      return undefined;
    }
    setLoading(true);
    const t = setTimeout(() => {
      resolvePoints({
        job_id: jobId,
        segment: { start: segStart, end: segEnd, signals: signalsRef.current },
        graph: graphRef.current,
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
    // Deliberate: refetch on `depKey` (the upstream signature) + window, not on every
    // graph object identity; the refs above keep the posted graph fresh regardless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depKey, jobId, nodeId, segStart, segEnd]);

  return { points, loading };
}
