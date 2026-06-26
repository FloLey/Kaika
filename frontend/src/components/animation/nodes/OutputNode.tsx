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
    groupClock,
    groupPlaying,
    segStart = 0,
  } = ctx || {};
  const videoRef = useRef<HTMLVideoElement>(null);

  const [videoUrl, setVideoUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const reqId = useRef(0);

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
          ) + JSON.stringify(output || {})
        : "",
    [graph, node.id, job, segment?.start, segment?.end, signals, output]
  );

  // Auto-render this output (debounced) whenever its render key changes. Request-id
  // guard drops stale responses. Not renderable (no fluid wired yet) → skip
  // silently and leave the well empty; only real backend failures show an error.
  useEffect(() => {
    if (!renderable) {
      setError("");
      return undefined;
    }
    const id = ++reqId.current;
    setBusy(true);
    setError("");
    const t = setTimeout(async () => {
      try {
        const { url } = await api.renderGraph({
          job_id: job as string,
          segment: { start: segment?.start, end: segment?.end, signals: segment?.signals },
          graph,
          output,
          output_id: node.id,
        });
        if (id !== reqId.current) return; // a newer edit superseded us
        setVideoUrl(url);
      } catch (e) {
        if (id === reqId.current) setError((e as Error)?.message || String(e));
      } finally {
        if (id === reqId.current) setBusy(false);
      }
    }, 300);
    return () => clearTimeout(t);
    // Deliberate: the debounced /animate fires on the serialized `renderKey`
    // (this output's subgraph hash), not on the graph object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderKey, renderable]);

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
        {busy && (
          <div className="anim-output-busy">
            <div className="anim-loader" aria-hidden="true">
              <span className="anim-loader-orb" />
              <span className="anim-loader-orb" />
              <span className="anim-loader-orb" />
            </div>
            <div className="anim-loader-label">rendering…</div>
          </div>
        )}
        {error && <div className="anim-output-err">{error}</div>}
      </div>
    </NodeFrame>
  );
}
