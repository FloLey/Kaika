import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { outputHash } from "../../../lib/graphModel";
import { useStreamRender } from "./useStreamRender";
import type { NodeCtx } from "./nodeProps";
import type { GraphNode } from "../../../lib/types";

interface Props {
  node: GraphNode;
  ctx?: NodeCtx;
  aspect?: string;
  compact?: boolean;
}

// The live streamed-render preview for a video producer (fluid / combine / output):
// the block-streamed <video>, slaved to the shared segment clock when playing and
// looping on its own when idle — the same behaviour the Output card has, factored out.
// Only streams while on-screen (viewport-gated) so a graph full of sims stays light.
export default function StreamPreview({ node, ctx, aspect = "1 / 1", compact = false }: Props) {
  const { graph, segment, job, signals, lyricLines, lyricsKey, groupClock, groupPlaying, segStart = 0, output } = ctx || {};
  const fps = (output as { fps?: number } | undefined)?.fps || 24;
  // This node's subgraph render key (same hash the Output card uses, for any producer).
  const renderKey = useMemo(
    () =>
      graph
        ? outputHash(graph, node.id, job as string | undefined, segment?.start, segment?.end, signals) +
          JSON.stringify(output || {}) +
          `|ly:${lyricsKey ?? JSON.stringify(lyricLines || [])}`
        : "",
    [graph, node.id, job, segment?.start, segment?.end, signals, output, lyricsKey, lyricLines]
  );
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [visible, setVisible] = useState(true);
  const lastTime = useRef(0);

  // Viewport gate: only stream a card that's actually on screen.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return undefined;
    const io = new IntersectionObserver(
      (entries) => setVisible(entries[0]?.isIntersecting ?? true),
      { threshold: 0.05 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const { videoUrl, busy, error, progress } = useStreamRender(ctx, node.id, renderKey, visible);

  // Preserve the playback position as the growing preview swaps <video> src.
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

  // Idle → loop on its own; playing → slave the frame to the shared segment clock.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !videoUrl) return undefined;
    if (!groupPlaying) {
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

  const renderLabel = progress
    ? `rendering ${Math.round(progress.done / fps)}s / ${Math.round(progress.total / fps)}s`
    : "rendering…";

  return (
    <div
      ref={wrapRef}
      className={"anim-output-well" + (compact ? " anim-output-well-sm" : "")}
      style={{ "--out-aspect": aspect } as CSSProperties}
    >
      {videoUrl && (
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
      )}
      {busy && !videoUrl && (
        <div className="anim-output-busy">
          <div className="anim-loader" aria-hidden="true">
            <span className="anim-loader-orb" />
            <span className="anim-loader-orb" />
            <span className="anim-loader-orb" />
          </div>
          {!compact && <div className="anim-loader-label">{renderLabel}</div>}
        </div>
      )}
      {busy && videoUrl && !compact && <div className="anim-output-progress">{renderLabel}</div>}
      {error && !compact && <div className="anim-output-err">{error}</div>}
    </div>
  );
}
