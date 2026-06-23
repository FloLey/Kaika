import { useEffect, useRef } from "react";

// Draws an extracted signal curve (0..1 over the segment's time window) as a
// filled line, with a playhead during playback. The playhead is driven by a
// requestAnimationFrame loop reading `audioRef`'s clock (same source the pulse
// pad uses) so it moves during both solo and "play segment" — no re-renders.
export default function CurveView({
  curve, color = "#60A5FA", loading,
  audioRef, segStart = 0, winLen = 1, playing,
}) {
  const headRef = useRef(null);
  const n = curve ? curve.length : 0;
  const pts =
    n > 1
      ? curve.map((v, i) => `${((i / (n - 1)) * 1000).toFixed(1)},${((1 - Math.max(0, Math.min(1, v))) * 100).toFixed(1)}`)
      : [];
  const line = pts.join(" ");
  const area = n > 1 ? `0,100 ${line} 1000,100` : "";

  useEffect(() => {
    const place = (t) => {
      const head = headRef.current;
      if (!head) return;
      const f = winLen > 0 ? Math.max(0, Math.min(1, (t - segStart) / winLen)) : 0;
      head.style.left = (f * 100).toFixed(2) + "%";
    };
    if (!playing || !audioRef) {
      place(audioRef && audioRef.current ? audioRef.current.currentTime : segStart);
      return;
    }
    let raf;
    const tick = () => {
      const el = audioRef.current;
      place(el ? el.currentTime : segStart);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, audioRef, segStart, winLen]);

  return (
    <div className="curve" style={{ "--accent": color }}>
      <svg viewBox="0 0 1000 100" preserveAspectRatio="none">
        {n > 1 && <polygon className="curve-fill" points={area} />}
        {n > 1 && <polyline className="curve-line" points={line} />}
      </svg>
      <div className="playhead" ref={headRef} style={{ left: 0 }} />
      {loading && <div className="curve-loading">…</div>}
      {!loading && n === 0 && <div className="curve-empty">no signal</div>}
    </div>
  );
}
