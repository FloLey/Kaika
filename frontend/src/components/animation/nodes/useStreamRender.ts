import { useEffect, useRef, useState } from "react";
import * as api from "../../../lib/api";
import type { NodeCtx } from "./nodeProps";

// Global cap on how many NODE-PREVIEW streams (fluid/combine cards) render at once, so
// a graph full of sims can't flood the render pool and starve the Output card (which
// streams on its own path, outside this cap). Cards over the cap hold their last frame
// until a slot frees. Small on purpose — "live" for the cards you're looking at.
const MAX_PREVIEW_STREAMS = 2;
let activePreviews = 0;
const waiters: (() => void)[] = [];
// A queued acquire that can be DEQUEUED: `cancel()` splices the waiter out, so a
// card unmounted while waiting doesn't briefly claim a slot just to give it back
// (which would delay the next real waiter by one cycle). Cancelling after the slot
// resolved is a no-op — the caller's stopped-check releases it instead.
function acquireSlot(): { promise: Promise<void>; cancel: () => void } {
  let entry: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    const tryAcquire = () => {
      if (activePreviews < MAX_PREVIEW_STREAMS) {
        activePreviews += 1;
        resolve();
      } else {
        entry = tryAcquire;
        waiters.push(tryAcquire);
      }
    };
    tryAcquire();
  });
  return {
    promise,
    cancel: () => {
      if (!entry) return;
      const i = waiters.indexOf(entry);
      if (i >= 0) waiters.splice(i, 1);
      entry = null;
    },
  };
}
function releaseSlot() {
  activePreviews = Math.max(0, activePreviews - 1);
  const next = waiters.shift();
  if (next) next();
}

// Progressive block-streamed render of ONE node's video (its `id` is the stream's
// output_id — the backend streams any video producer, not just output nodes, and
// output_hash covers its contributing sub-DAG). Extracted from OutputNode so fluid /
// combine cards can show their live sim/composite too.
//
// `active` gates the whole thing (pass false for off-screen cards to keep a big graph
// light — the last frame stays on screen). `renderKey` is the serialized subgraph hash
// (from outputHash) — the debounced stream (re)starts only when it changes.
//
// `opts.slot` (default true) takes one of the MAX_PREVIEW_STREAMS slots above. Output
// cards pass `false`: an output is what the user is actually waiting on, so it must
// never queue behind the card previews.
export function useStreamRender(
  ctx: NodeCtx | undefined,
  nodeId: string,
  renderKey: string,
  active: boolean,
  opts: { slot?: boolean } = {}
): { videoUrl: string; busy: boolean; error: string; progress: { done: number; total: number } | null } {
  const useSlot = opts.slot ?? true;
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
      setError("");
      return undefined;
    }
    const id = ++reqId.current;
    setBusy(true);
    setError("");
    let stopped = false;
    let myRender: string | null = null;
    let slotHeld = false;
    let slot: ReturnType<typeof acquireSlot> | null = null;
    const t = setTimeout(async () => {
      // Wait for a preview slot so at most MAX_PREVIEW_STREAMS render at once.
      if (useSlot) {
        slot = acquireSlot();
        await slot.promise;
        if (stopped || id !== reqId.current) {
          releaseSlot();
          return;
        }
        slotHeld = true;
      } else if (stopped || id !== reqId.current) {
        return;
      }
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
        if (slotHeld) {
          releaseSlot();
          slotHeld = false;
        }
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
      slot?.cancel(); // dequeue if still waiting (no-op once resolved)
      if (slotHeld) {
        releaseSlot();
        slotHeld = false;
      }
      if (myRender) api.cancelStreamRender(myRender);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderKey, active]);

  return { videoUrl, busy, error, progress };
}
