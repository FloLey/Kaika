import { useEffect, useRef } from "react";

// A live preview of one signal: a square whose inner dot scales + glows with the
// curve value at the playhead — what this signal would drive in the simulation.
// Driven by requestAnimationFrame (not React state) so it stays smooth at 60fps.
// `idleLoop` (opt-in): when not playing, cycle the dot through the curve on its
// own so the signal reads as "alive" without driving the transport. Studio leaves
// it off (the pad settles to the playhead); the animation tab turns it on.
export default function PulsePad({ audioRef, curve, segStart, winLen, color, playing, idleLoop = false }) {
  const dotRef = useRef(null);

  function valueAt(time) {
    if (!curve || !curve.length || winLen <= 0) return 0;
    const f = Math.max(0, Math.min(1, (time - segStart) / winLen));
    return curve[Math.min(curve.length - 1, Math.round(f * (curve.length - 1)))] || 0;
  }

  function paint(v) {
    const dot = dotRef.current;
    if (!dot) return;
    dot.style.transform = `scale(${(0.2 + v * 0.8).toFixed(3)})`;
    dot.style.opacity = (0.2 + v * 0.8).toFixed(3);
    dot.style.boxShadow = `0 0 ${(v * 28).toFixed(1)}px ${color}`;
  }

  useEffect(() => {
    // Playing: follow the shared audio clock.
    if (playing) {
      let raf;
      const tick = () => {
        const el = audioRef && audioRef.current;
        paint(valueAt(el ? el.currentTime : segStart));
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }
    // Idle + idleLoop: cycle through the curve over winLen so the pad pulses on
    // its own. Uses rAF timestamps for the phase (no wall clock).
    if (idleLoop && curve && curve.length) {
      let raf;
      let t0 = null;
      const tick = (ts) => {
        if (t0 == null) t0 = ts;
        const phase = winLen > 0 ? (((ts - t0) / 1000) / winLen) % 1 : 0;
        paint(curve[Math.min(curve.length - 1, Math.round(phase * (curve.length - 1)))] || 0);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }
    // Idle, no loop: settle to the value at the current playhead.
    paint(valueAt(audioRef && audioRef.current ? audioRef.current.currentTime : segStart));
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, idleLoop, curve, segStart, winLen, color]);

  return (
    <div className="pulse-pad" style={{ "--accent": color }}>
      <div className="pulse-dot" ref={dotRef} />
    </div>
  );
}
