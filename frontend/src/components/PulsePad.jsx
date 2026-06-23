import { useEffect, useRef } from "react";

// A live preview of one signal: a square whose inner dot scales + glows with the
// curve value at the playhead — what this signal would drive in the simulation.
// Driven by requestAnimationFrame (not React state) so it stays smooth at 60fps.
export default function PulsePad({ audioRef, curve, segStart, winLen, color, playing }) {
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
    if (!playing) {
      // settle to the value at the current playhead
      paint(valueAt(audioRef.current ? audioRef.current.currentTime : segStart));
      return;
    }
    let raf;
    const tick = () => {
      const el = audioRef.current;
      paint(valueAt(el ? el.currentTime : segStart));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, curve, segStart, winLen, color]);

  return (
    <div className="pulse-pad" style={{ "--accent": color }}>
      <div className="pulse-dot" ref={dotRef} />
    </div>
  );
}
