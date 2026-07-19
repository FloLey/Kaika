import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { nodeRenderable, outputHash } from "../../../lib/graphModel";
import { usePreservePlayback } from "./usePreservePlayback";
import { forgetRender, useStreamRender } from "./useStreamRender";
import { useSyncedPlayback } from "./useSyncedPlayback";
import type { NodeCtx } from "./nodeProps";
import type { GraphNode } from "../../../lib/types";

interface Props {
  node: GraphNode;
  ctx?: NodeCtx;
  aspect?: string;
  compact?: boolean;
  // Extra render gate on top of viewport visibility. Defaults ON — every on-screen
  // producer streams; the global 2-slot queue in useStreamRender keeps a dense graph
  // from flooding the pool. Pass false only to force-hold a card's frame.
  active?: boolean;
}

// The live streamed-render preview for a video producer (fluid / combine / output):
// the block-streamed <video>, slaved to the shared segment clock when playing and
// looping on its own when idle — the same behaviour the Output card has, factored out.
// Streams whenever on-screen (the slot queue staggers a graph full of sims).
export default function StreamPreview({
  node,
  ctx,
  aspect = "1 / 1",
  compact = false,
  active = true,
}: Props) {
  const {
    graph,
    segment,
    job,
    signals,
    lyricLines,
    lyricsKey,
    groupClock,
    groupPlaying,
    segStart = 0,
    output,
  } = ctx || {};
  const fps = (output as { fps?: number } | undefined)?.fps || 24;
  // This node's subgraph render key (same hash the Output card uses, for any producer).
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
          `|ly:${lyricsKey ?? JSON.stringify(lyricLines || [])}`
        : "",
    [graph, node.id, job, segment?.start, segment?.end, signals, output, lyricsKey, lyricLines]
  );
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [visible, setVisible] = useState(true);

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

  // Only stream what the backend would accept: a half-wired producer (combine with
  // no input, dangling binding…) holds its last frame instead of posting a render
  // that can only 400 — mid-wiring stays quiet.
  const renderable = useMemo(
    () => (graph ? nodeRenderable(graph, node.id) : false),
    [graph, node.id]
  );
  // The settings window renders ONE preview in its right column (via CompactPreview) and
  // sets ctx.previewInPanel on the ctx it hands the card, so the card's own inline preview
  // suppresses itself — no double image, and no second render stream for the same node.
  const suppressed = !!ctx?.previewInPanel;
  const { videoUrl, busy, error, progress } = useStreamRender(
    ctx,
    node.id,
    renderKey,
    visible && active && renderable && !suppressed
  );

  // Restore-on-reload only while the transport is stopped: when it's playing,
  // useSyncedPlayback owns currentTime (it has the real clock) and a second writer
  // would race its drift correction.
  usePreservePlayback(videoRef, videoUrl, !groupPlaying);
  useSyncedPlayback(videoRef, videoUrl, groupPlaying, groupClock, segStart);

  const renderLabel = progress
    ? `rendering ${Math.round(progress.done / fps)}s / ${Math.round(progress.total / fps)}s`
    : "rendering…";

  if (suppressed) return null; // the settings window shows the preview in its own column

  return (
    <div
      ref={wrapRef}
      className={"anim-output-well" + (compact ? " anim-output-well-sm" : "")}
      style={{ "--out-aspect": aspect } as CSSProperties}
    >
      {/* `loop`/`autoPlay` are UNCONDITIONAL. They used to be !groupPlaying, so during
          playback the clip reached its end, fired `ended` and STUCK on the last frame
          while the audio looped back. Native looping wraps frame-accurate with no
          seek — and useSyncedPlayback's wrap-aware drift maths assumes it. */}
      {videoUrl && (
        <video
          ref={videoRef}
          className="anim-output-video"
          src={videoUrl}
          muted
          playsInline
          preload="auto"
          loop
          autoPlay
          onError={() => forgetRender(videoUrl)}
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
