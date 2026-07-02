import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import NodeFrame, { Port } from "./NodeFrame";
import { outputHash, outputRenderable } from "../../../lib/graphModel";
import { aspectOf } from "../../../lib/output";
import * as api from "../../../lib/api";
import type { NodeProps } from "./nodeProps";

// The render sink (01 §3.1 output). One `in` video port; the body is the rendered
// clip. Each output node renders ITS OWN pipeline (the fluid wired into it, N per
// graph) — it owns its busy/error/url and a debounced /animate request keyed on a
// per-output subgraph hash, so editing one pipeline re-renders only its output.
// The video's frame is slaved to the SHARED segment clock (ctx.groupClock =
// Studio's refAudio) so it plays and scrubs in lock-step with the segment audio and
// the signal pulse pads. Shows not-rendered / rendering / error states.
export default function OutputNode({ node, selected, helpers, ctx, onDelete }: NodeProps) {
  const {
    graph,
    segment,
    job,
    output,
    signals,
    lyricLines,
    groupClock,
    groupPlaying,
    segStart = 0,
    finalOutputId,
    setFinalOutput,
  } = ctx || {};
  const videoRef = useRef<HTMLVideoElement>(null);

  const [videoUrl, setVideoUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const reqId = useRef(0);
  const activeRender = useRef<string | null>(null); // render_id we're streaming, to cancel on edit
  const lastTime = useRef(0); // playback position, preserved as the growing preview swaps src

  const fps = (output as { fps?: number } | undefined)?.fps || 24;

  // The preview well adopts the project output aspect so portrait/landscape is
  // visible while editing (the rendered clip matches this exact shape).
  const aspect = output ? aspectOf(output) : "1 / 1";

  // Render key: this output's subgraph + the project render settings. Changes only
  // when THIS output's rendered clip would (see graphModel.outputHash).
  // Memoized: outputRenderable walks the whole contributing DAG; don't redo it on
  // every unrelated re-render (playhead ticks, sibling-node edits).
  const renderable = useMemo(
    () => (graph ? outputRenderable(graph, node.id) : false),
    [graph, node.id]
  );
  const renderKey = useMemo(
    () =>
      graph
        ? outputHash(
            graph,
            node.id,
            job as string | undefined,
            segment?.start,
            segment?.end,
            signals
          ) +
          JSON.stringify(output || {}) +
          // The backend folds a lyrics card's burned-in text into output_hash, so a
          // change to the aligned lines (which arrive async) must re-trigger the render.
          `|ly:${JSON.stringify(lyricLines || [])}`
        : "",
    [graph, node.id, job, segment?.start, segment?.end, signals, output, lyricLines]
  );

  // Auto-render this output (debounced) whenever its render key changes. The render
  // STREAMS in ~5s blocks: we start a background job and poll it, updating the
  // preview as each block lands (5s→10s→…) so a long segment shows something in a
  // block's time instead of after the whole clip. A request-id guard drops stale
  // responses; the previous render is cancelled so an abandoned edit stops early.
  // Not renderable (no fluid wired yet) → skip silently; only backend failures show.
  useEffect(() => {
    if (!renderable) {
      setError("");
      setBusy(false);
      setProgress(null);
      return undefined;
    }
    const id = ++reqId.current;
    setBusy(true);
    setError("");
    lastTime.current = 0; // a fresh edit restarts the preview from the top
    let stopped = false;
    let myRender: string | null = null;
    const t = setTimeout(async () => {
      if (activeRender.current) api.cancelStreamRender(activeRender.current); // stop the prior render
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
          output_id: node.id,
        });
        if (stopped || id !== reqId.current) {
          api.cancelStreamRender(render_id); // superseded before we could poll it
          return;
        }
        myRender = render_id;
        activeRender.current = render_id;
        for (;;) {
          const st = await api.getStreamStatus(render_id);
          if (stopped || id !== reqId.current) return; // a newer edit took over
          if (st.total) setProgress({ done: st.frames_done, total: st.total });
          if (st.state === "running") {
            if (st.preview_url) setVideoUrl(st.preview_url); // grows block by block
            await new Promise((r) => setTimeout(r, 250));
            continue;
          }
          if (st.state === "done") {
            if (st.url) setVideoUrl(st.url);
          } else if (st.state === "error") {
            throw new Error(st.error || "render failed");
          }
          break; // done | error | cancelled
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
      if (myRender) api.cancelStreamRender(myRender); // this render is superseded — stop it
    };
    // Deliberate: the debounced stream fires on the serialized `renderKey`
    // (this output's subgraph hash), not on the graph object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderKey, renderable]);

  // Preserve the playback position as the growing preview (or the final clip) swaps
  // the <video> src — otherwise every new block would restart from 0. We remember
  // the last position and seek back once the new (longer) source is loaded.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !videoUrl) return undefined;
    const save = () => {
      if (v.currentTime) lastTime.current = v.currentTime;
    };
    const restore = () => {
      if (lastTime.current > 0 && lastTime.current < v.duration) v.currentTime = lastTime.current;
    };
    v.addEventListener("timeupdate", save);
    v.addEventListener("loadedmetadata", restore);
    return () => {
      v.removeEventListener("timeupdate", save);
      v.removeEventListener("loadedmetadata", restore);
    };
  }, [videoUrl]);

  // Two playback modes:
  //  • idle (segment not playing) — the clip loops on its own, so the pulse-driven
  //    motion is obvious at a glance without touching the transport.
  //  • previewing (segment playing) — the frame is slaved to the shared segment
  //    clock so the video lines up with the audio + signal pulse pads, and scrubs
  //    with the timeline.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !videoUrl) return undefined;
    if (!groupPlaying) {
      // Idle preview: the <video> carries `autoPlay loop` (declarative — see JSX),
      // so the browser loops every freshly-rendered clip on its own. We still kick
      // play() here + on `canplay` to cover the playing->idle resume, where the
      // src is already loaded so the autoPlay attribute won't re-trigger.
      // Resume the loop whenever it has stalled. Switching macOS Spaces / tabs
      // backgrounds the page; the browser pauses background <video> and autoPlay
      // won't re-fire, so previews come back frozen. A single "we're back" event
      // (visibilitychange) isn't reliable across Spaces, so we also poll: if the
      // clip is paused while the page is visible, nudge it. play() only runs when
      // visible, so we never fight the browser's background pause.
      const play = () => {
        if (document.visibilityState !== "visible") return;
        const p = v.play && v.play();
        if (p && p.catch) p.catch(() => {});
      };
      play();
      v.addEventListener("canplay", play);
      document.addEventListener("visibilitychange", play);
      window.addEventListener("focus", play);
      const watchdog = setInterval(() => {
        if (v.paused) play();
      }, 1000);
      return () => {
        v.removeEventListener("canplay", play);
        document.removeEventListener("visibilitychange", play);
        window.removeEventListener("focus", play);
        clearInterval(watchdog);
      };
    }
    v.pause();
    let raf: number;
    const sync = () => {
      const a = groupClock && groupClock.current;
      if (a && v.duration) {
        const target = Math.min(Math.max(a.currentTime - segStart, 0), v.duration - 0.001);
        if (Math.abs(v.currentTime - target) > 0.034) v.currentTime = target;
      }
      raf = requestAnimationFrame(sync);
    };
    raf = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(raf);
  }, [videoUrl, groupPlaying, groupClock, segStart]);

  // "rendering 15s / 55s" while blocks stream in; a bare spinner label before the
  // first frame count arrives.
  const renderLabel = progress
    ? `rendering ${Math.round(progress.done / fps)}s / ${Math.round(progress.total / fps)}s`
    : "rendering…";

  // Whether THIS output is the segment's marked "final" render (what the export
  // stage stitches). Toggling passes "" to clear the mark.
  const isFinal = finalOutputId === node.id;

  return (
    <NodeFrame
      node={node}
      title="output"
      accent="var(--text)"
      selected={selected}
      onTitlePointerDown={helpers.onTitlePointerDown}
      onDelete={onDelete}
      sideIn={
        <Port
          kind="in"
          flow="video"
          nodeId={node.id}
          portId="video"
          portRef={helpers.portRef}
          title="video in"
        />
      }
      sideOut={
        <Port
          kind="out"
          flow="video"
          nodeId={node.id}
          portId="out"
          portRef={helpers.portRef}
          startConnect={helpers.startConnect}
          title="pass video through"
        />
      }
    >
      {/* Mark this output as the segment's FINAL render — the one the export stage
          stitches into the full-track clip. One per segment; toggling clears it. */}
      {setFinalOutput && (
        <button
          className={"anim-final-btn" + (isFinal ? " on" : "")}
          onClick={() => setFinalOutput(isFinal ? "" : node.id)}
          title={
            isFinal
              ? "This output is the segment's final (exported) render — click to unmark"
              : "Mark this output as the segment's final (exported) render"
          }
        >
          {isFinal ? "★ final" : "☆ mark final"}
        </button>
      )}
      <div className="anim-output-well" style={{ "--out-aspect": aspect } as CSSProperties}>
        {videoUrl ? (
          <video
            ref={videoRef}
            className="anim-output-video"
            src={videoUrl}
            muted
            playsInline
            preload="auto"
            loop={!groupPlaying}
            autoPlay={!groupPlaying}
          />
        ) : (
          !busy &&
          !error && (
            <div className="anim-output-empty">
              {renderable ? "not rendered yet" : "wire a fluid into this output"}
            </div>
          )
        )}
        {busy && !videoUrl && (
          <div className="anim-output-busy">
            <div className="anim-loader" aria-hidden="true">
              <span className="anim-loader-orb" />
              <span className="anim-loader-orb" />
              <span className="anim-loader-orb" />
            </div>
            <div className="anim-loader-label">{renderLabel}</div>
          </div>
        )}
        {busy && videoUrl && <div className="anim-output-progress">{renderLabel}</div>}
        {error && <div className="anim-output-err">{error}</div>}
      </div>
    </NodeFrame>
  );
}
