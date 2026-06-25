import { useEffect, useRef } from "react";
import NodeFrame, { Port } from "./NodeFrame.jsx";

// The render sink (01 §3.1 output). One `in` video port; the body is the rendered
// clip. The video's frame is slaved to the SHARED segment clock (ctx.groupClock =
// Studio's refAudio) so it plays and scrubs in lock-step with the segment audio and
// the signal pulse pads — pressing play on the transport animates everything from
// one playhead; scrubbing the timeline scrubs the video. Shows not-rendered /
// rendering / error states.
export default function OutputNode({ node, selected, helpers, ctx, onDelete }) {
  const { videoUrl, busy, error, groupClock, groupPlaying, segStart = 0, output } = ctx || {};
  const videoRef = useRef(null);

  // The preview well adopts the project output aspect so portrait/landscape is
  // visible while editing (the rendered clip matches this exact shape).
  const aspect = output ? `${output.width} / ${output.height}` : "1 / 1";

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
      v.loop = true;
      const p = v.play && v.play();
      if (p && p.catch) p.catch(() => {});
      return undefined;
    }
    v.loop = false;
    v.pause();
    let raf;
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
    >
      <div className="anim-output-well" style={{ "--out-aspect": aspect }}>
        {videoUrl ? (
          <video
            ref={videoRef}
            className="anim-output-video"
            src={videoUrl}
            muted
            playsInline
            preload="auto"
          />
        ) : (
          !busy && !error && <div className="anim-output-empty">not rendered yet</div>
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
