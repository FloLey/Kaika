import { useEffect, useRef, useState } from "react";
import * as api from "../../../lib/api";
import type { NodeCtx } from "./nodeProps";

// Progressive block-streamed render of ONE node's video (its `id` is the stream's
// output_id — the backend streams any video producer, not just output nodes, and
// output_hash covers its contributing sub-DAG). Extracted from OutputNode so fluid /
// combine cards can show their live sim/composite too.
//
// `active` gates the whole thing (pass false for off-screen cards to keep a big graph
// light — the last frame stays on screen). `renderKey` is the serialized subgraph hash
// (from outputHash) — the debounced stream (re)starts only when it changes.
export function useStreamRender(
  ctx: NodeCtx | undefined,
  nodeId: string,
  renderKey: string,
  active: boolean
): { videoUrl: string; busy: boolean; error: string; progress: { done: number; total: number } | null } {
  const { graph, segment, job, output, lyricLines } = ctx || {};
  const [videoUrl, setVideoUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const reqId = useRef(0);
  const activeRender = useRef<string | null>(null);

  useEffect(() => {
    if (!active || !graph || !job) {
      setBusy(false);
      setProgress(null);
      return undefined;
    }
    const id = ++reqId.current;
    setBusy(true);
    setError("");
    let stopped = false;
    let myRender: string | null = null;
    const t = setTimeout(async () => {
      if (activeRender.current) api.cancelStreamRender(activeRender.current);
      try {
        const { render_id } = await api.startStreamRender({
          job_id: job as string,
          segment: {
            start: segment?.start,
            end: segment?.end,
            signals: segment?.signals,
            lyric_lines: lyricLines,
          },
          graph,
          output,
          output_id: nodeId,
        });
        if (stopped || id !== reqId.current) {
          api.cancelStreamRender(render_id);
          return;
        }
        myRender = render_id;
        activeRender.current = render_id;
        let pollMs = 250;
        let lastDone = -1;
        for (;;) {
          const st = await api.getStreamStatus(render_id);
          if (stopped || id !== reqId.current) return;
          if (st.total) setProgress({ done: st.frames_done, total: st.total });
          if (st.state === "running") {
            if (st.preview_url) setVideoUrl(st.preview_url);
            pollMs = st.frames_done !== lastDone ? 250 : Math.min(pollMs * 2, 1000);
            lastDone = st.frames_done;
            await new Promise((r) => setTimeout(r, pollMs));
            continue;
          }
          if (st.state === "done") {
            if (st.url) setVideoUrl(st.url);
          } else if (st.state === "error") {
            throw new Error(st.error || "render failed");
          }
          break;
        }
      } catch (e) {
        if (id === reqId.current) setError((e as Error)?.message || String(e));
      } finally {
        if (id === reqId.current) {
          setBusy(false);
          setProgress(null);
          if (activeRender.current === myRender) activeRender.current = null;
        }
      }
    }, 300);
    return () => {
      stopped = true;
      clearTimeout(t);
      if (myRender) api.cancelStreamRender(myRender);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderKey, active]);

  return { videoUrl, busy, error, progress };
}
