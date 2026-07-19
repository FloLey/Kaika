import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./api";

// Following a LONG backend render (whole-song export, single-segment HD render) —
// the counterpart to `useStreamRender`, which drives the short, disposable card
// previews. The difference is the lifetime: these renders take minutes and cost
// real work, so this hook
//   - NEVER cancels on unmount (leaving the stage/card must not throw the render
//     away — only an explicit `cancel()` does),
//   - persists the render_id in sessionStorage under `storeKey` and re-attaches to
//     it on remount, so navigating away and back keeps showing the same progress,
//   - surfaces the backend's `phase` ("assets" / "render" / "audio") so a job doing
//     slow work outside the frame loop doesn't look hung at 0%.
// Both consumers poll the same `/export/stream/<id>` endpoints (they're generic
// over render_jobs), so `start` just takes whichever kick-off call is relevant.

export interface RenderJobState {
  busy: boolean;
  error: string;
  progress: { done: number; total: number } | null;
  phase: string | null;
  videoUrl: string; // the growing preview while running, the finished file when done
  finalUrl: string; // set only once the render completed (enables download)
}

const POLL_MS = 500;

export function useRenderJob(storeKey: string | null) {
  const [videoUrl, setVideoUrl] = useState("");
  const [finalUrl, setFinalUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const activeRender = useRef<string | null>(null); // render_id we're polling
  const mounted = useRef(true); // false after unmount → stop touching state (never cancels)

  // Poll a running render into state. Shared by `start()` and the resume effect.
  const poll = useCallback(
    async (renderId: string) => {
      activeRender.current = renderId;
      setBusy(true);
      setError("");
      let terminal = false;
      try {
        for (;;) {
          const st = await api.getExportStatus(renderId);
          if (!mounted.current || activeRender.current !== renderId) return; // left / superseded
          if (st.total) setProgress({ done: st.frames_done, total: st.total });
          if (st.phase !== undefined) setPhase(st.phase);
          if (st.state === "running") {
            if (st.preview_url) setVideoUrl(st.preview_url); // grows block by block
            await new Promise((r) => setTimeout(r, POLL_MS));
            continue;
          }
          terminal = true;
          if (st.state === "done") {
            if (st.url) {
              setVideoUrl(st.url);
              setFinalUrl(st.url);
            }
          } else if (st.state === "error") {
            throw new Error(st.error || "render failed");
          }
          // "gone" (the backend forgot this render_id, e.g. after a dev-server reload)
          // ends the attempt quietly — same as a stream render, no error banner.
          break; // done | error | cancelled | gone
        }
      } catch (e) {
        terminal = true; // a failed poll (e.g. the render expired) ends this attempt
        if (mounted.current) setError((e as Error)?.message || String(e));
      } finally {
        if (terminal) {
          if (storeKey) sessionStorage.removeItem(storeKey);
          activeRender.current = null;
          if (mounted.current) {
            setBusy(false);
            setProgress(null);
            setPhase(null);
          }
        }
      }
    },
    [storeKey]
  );

  // Re-attach to an in-flight render when remounting (it kept running while away).
  // A stored id that's already gone is cleared by the poll's first fetch.
  useEffect(() => {
    mounted.current = true;
    const pending = storeKey ? sessionStorage.getItem(storeKey) : null;
    if (pending) poll(pending);
    return () => {
      mounted.current = false; // stop touching state; the backend render keeps running
    };
  }, [storeKey, poll]);

  // Kick off a render: `kick` performs the POST and returns its render_id. Its id is
  // persisted BEFORE polling so a reload mid-flight still finds it.
  const start = useCallback(
    async (kick: () => Promise<{ render_id: string }>, opts?: { reset?: boolean }) => {
      if (busy) return;
      setBusy(true);
      setError("");
      setProgress(null);
      setPhase(null);
      if (opts?.reset !== false) {
        setVideoUrl("");
        setFinalUrl("");
      }
      try {
        const { render_id } = await kick();
        if (storeKey) sessionStorage.setItem(storeKey, render_id);
        poll(render_id);
      } catch (e) {
        setBusy(false);
        setError((e as Error)?.message || String(e));
      }
    },
    [busy, poll, storeKey]
  );

  // Stop the backend render after its current block (the only thing that cancels).
  const cancel = useCallback(() => {
    const rid = activeRender.current;
    if (!rid) return;
    api.cancelExport(rid);
    activeRender.current = null;
    if (storeKey) sessionStorage.removeItem(storeKey);
    setBusy(false);
    setProgress(null);
    setPhase(null);
  }, [storeKey]);

  return { busy, error, progress, phase, videoUrl, finalUrl, start, cancel, setError };
}
