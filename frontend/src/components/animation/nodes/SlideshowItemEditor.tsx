import { useEffect, useRef, useState } from "react";

// The video in-point mini-editor: a small popover with a scrubbable <video> and a range
// slider. Since a slideshow video plays for as long as the trigger keeps it visible, the
// only per-video choice is WHERE the extract starts — this picks that `start` (seconds)
// visually. Pure frontend: the served .mp4 scrubs client-side, no backend preview. The
// chosen time is committed on close (onCommit) so we don't thrash node data while dragging.
export default function SlideshowItemEditor({
  url,
  start,
  onCommit,
  onClose,
}: {
  url: string;
  start: number;
  onCommit: (start: number) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [t, setT] = useState(start);
  const [dur, setDur] = useState(0);

  // Seek the preview to the current pick whenever it changes (the slider drives it).
  useEffect(() => {
    const v = videoRef.current;
    if (v && Number.isFinite(t)) v.currentTime = Math.min(t, dur || t);
  }, [t, dur]);

  const commit = () => {
    onCommit(t);
    onClose();
  };

  return (
    <div className="anim-slide-editor-backdrop no-drag" onClick={commit}>
      <div className="anim-slide-editor" onClick={(e) => e.stopPropagation()}>
        <div className="anim-slide-editor-head">
          <span>in-point</span>
          <button className="anim-slide-editor-close" title="done" onClick={commit}>
            ✓
          </button>
        </div>
        <video
          ref={videoRef}
          src={url}
          muted
          playsInline
          preload="metadata"
          onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 0)}
        />
        <input
          type="range"
          min={0}
          max={dur || 0}
          step={0.05}
          value={Math.min(t, dur || t)}
          onChange={(e) => setT(parseFloat(e.target.value))}
        />
        <div className="anim-slide-editor-time">
          <span>{t.toFixed(2)}s</span>
          {dur > 0 && <span className="anim-slide-editor-dur">/ {dur.toFixed(1)}s</span>}
        </div>
      </div>
    </div>
  );
}
