import { useEffect, useRef, useState } from "react";
import * as api from "../../../lib/api";
import type { NodeCtx } from "./nodeProps";

// Two INDEPENDENT render lanes, not one shared cap. An output is what the user is
// actually waiting on, so it must never queue behind a card preview — one shared queue
// would give exactly that head-of-line blocking. Separate queues bound the total
// without ordering the two kinds against each other. The sum matches the backend's
// RENDER_WORKERS (render_jobs.py) so the pool isn't oversubscribed; if HD renders /
// exports start feeling starved behind previews, drop `output` to 1.
const LANE_CAPS = { preview: 2, output: 2 } as const;
export type RenderLane = keyof typeof LANE_CAPS;
const activeCount: Record<RenderLane, number> = { preview: 0, output: 0 };
const waiters: Record<RenderLane, (() => void)[]> = { preview: [], output: [] };

// A queued acquire that can be DEQUEUED: `cancel()` splices the waiter out, so a
// card unmounted while waiting doesn't briefly claim a slot just to give it back
// (which would delay the next real waiter by one cycle). Cancelling after the slot
// resolved is a no-op — the caller's stopped-check releases it instead.
function acquireSlot(lane: RenderLane): { promise: Promise<void>; cancel: () => void } {
  let entry: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    const tryAcquire = () => {
      if (activeCount[lane] < LANE_CAPS[lane]) {
        activeCount[lane] += 1;
        resolve();
      } else {
        entry = tryAcquire;
        waiters[lane].push(tryAcquire);
      }
    };
    tryAcquire();
  });
  return {
    promise,
    cancel: () => {
      if (!entry) return;
      const i = waiters[lane].indexOf(entry);
      if (i >= 0) waiters[lane].splice(i, 1);
      entry = null;
    },
  };
}
function releaseSlot(lane: RenderLane) {
  activeCount[lane] = Math.max(0, activeCount[lane] - 1);
  const next = waiters[lane].shift();
  if (next) next();
}

// Session memo of renderKey -> finished clip url. A render key is a content hash of the
// contributing subgraph, so the same key ALWAYS means the same clip — and the backend
// caches that clip on disk by the same identity. Without this memo, going back to a
// state we already rendered (undo/redo, nudging a slider back, reopening a card) paid a
// full round trip — debounce, POST, poll — just to be told about a file we already knew.
// With it, that case is instant and silent.
//
// Module-level so it survives a card unmounting/remounting (pan a card off screen and
// back, open and close the settings window). Bounded: the cache GC can sweep a clip
// after ~30 min idle, so a dead entry is possible — the <video>'s onError calls
// `forgetRender` and the normal render path takes over.
const renderMemo = new Map<string, string>();
const MEMO_MAX = 200; // ~a long editing session; oldest-first eviction

function rememberRender(key: string, url: string) {
  if (renderMemo.has(key)) renderMemo.delete(key); // re-insert => most-recently-used last
  renderMemo.set(key, url);
  if (renderMemo.size > MEMO_MAX) {
    const oldest = renderMemo.keys().next().value;
    if (oldest !== undefined) renderMemo.delete(oldest);
  }
}

// Drop a memoized url that turned out to be dead (the file was swept). Exported so the
// <video> error handler can invalidate it and let the render path rebuild the clip.
export function forgetRender(url: string) {
  for (const [k, v] of renderMemo) if (v === url) renderMemo.delete(k);
}

// Progressive block-streamed render of ONE node's video (its `id` is the stream's
// output_id — the backend streams any video producer, not just output nodes, and
// output_hash covers its contributing sub-DAG). Extracted from OutputNode so fluid /
// combine cards can show their live sim/composite too.
//
// `active` gates STARTING a render (pass false for off-screen cards to keep a big graph
// light — the last frame stays on screen). `renderKey` is the serialized subgraph hash
// (from outputHash) — the debounced stream (re)starts only when it changes.
//
// `opts.lane` picks the queue (default "preview"); output cards pass "output".
export function useStreamRender(
  ctx: NodeCtx | undefined,
  nodeId: string,
  renderKey: string,
  active: boolean,
  opts: { lane?: RenderLane } = {}
): {
  videoUrl: string;
  busy: boolean;
  error: string;
  progress: { done: number; total: number } | null;
} {
  const lane = opts.lane ?? "preview";
  const { graph, segment, job, output, lyricLines, groupClock } = ctx || {};
  const [videoUrl, setVideoUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const reqId = useRef(0);
  const activeRender = useRef<string | null>(null);
  // Read at poll time rather than captured in the effect's deps: pressing play must not
  // restart a render, it only changes whether we're allowed to swap the <video> src.
  const clockRef = useRef(groupClock);
  clockRef.current = groupClock;

  // `active` gates STARTING a render, never interrupting one. It carries the viewport
  // gate (StreamPreview's IntersectionObserver), so without this latch simply panning or
  // zooming the canvas cancelled every in-flight card render and the backend threw away
  // its scratch — all that work re-done the moment the card scrolled back. Once a key
  // has started it stays gated on; a NEW key off-screen still waits for visibility.
  const startedKey = useRef<string | null>(null);
  const gate = active || startedKey.current === renderKey;

  useEffect(() => {
    if (!gate || !graph || !job) {
      setBusy(false);
      setProgress(null);
      setError("");
      return undefined;
    }
    // Already rendered this exact state in this session: show it immediately. No
    // debounce, no slot, no request — and nothing to cancel on cleanup.
    const memo = renderMemo.get(renderKey);
    if (memo) {
      setVideoUrl(memo);
      setBusy(false);
      setProgress(null);
      setError("");
      return undefined;
    }
    const id = ++reqId.current;
    startedKey.current = renderKey; // from here the viewport can't cancel this render
    setBusy(true);
    setError("");
    let stopped = false;
    let myRender: string | null = null;
    let slotHeld = false;
    let slot: ReturnType<typeof acquireSlot> | null = null;
    const t = setTimeout(async () => {
      // Wait for a slot in this lane so the render pool isn't flooded.
      slot = acquireSlot(lane);
      await slot.promise;
      if (stopped || id !== reqId.current) {
        releaseSlot(lane);
        return;
      }
      slotHeld = true;
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
            // The growing preview gets a new `?n=<blocks>` url per block, and adopting
            // it RELOADS the element: playback restarts and useSyncedPlayback's effect
            // re-runs. That's fine while the transport is stopped (you get to watch the
            // render fill in), but during playback it would yank the picture every ~5s —
            // exactly when the user is trying to judge the clip against the music. So
            // while playing we hold the current frame and take the finished clip below,
            // in ONE swap.
            const playing = !!clockRef.current?.current && !clockRef.current.current.paused;
            if (st.preview_url && !playing) setVideoUrl(st.preview_url);
            pollMs = st.frames_done !== lastDone ? 250 : Math.min(pollMs * 2, 1000);
            lastDone = st.frames_done;
            await new Promise((r) => setTimeout(r, pollMs));
            continue;
          }
          if (st.state === "done") {
            if (st.url) {
              rememberRender(renderKey, st.url);
              setVideoUrl(st.url);
            }
          } else if (st.state === "error") {
            throw new Error(st.error || "render failed");
          }
          break;
        }
      } catch (e) {
        if (id === reqId.current) setError((e as Error)?.message || String(e));
      } finally {
        if (slotHeld) {
          releaseSlot(lane);
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
        releaseSlot(lane);
        slotHeld = false;
      }
      if (myRender) api.cancelStreamRender(myRender);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderKey, gate]);

  return { videoUrl, busy, error, progress };
}
