import { useEffect, useRef } from "react";
import type { CSSProperties, RefObject } from "react";

interface PulsePadProps {
  audioRef?: RefObject<HTMLAudioElement | null>;
  curve?: number[];
  segStart?: number;
  winLen?: number;
  color?: string;
  playing?: boolean;
  idleLoop?: boolean;
}

// A live preview of one signal: a square whose inner dot scales + glows with the
// curve value at the playhead — what this signal would drive in the simulation.
// Driven by requestAnimationFrame (not React state) so it stays smooth at 60fps.
// `idleLoop` (opt-in): when not playing, cycle the dot through the curve on its
// own so the signal reads as "alive" without driving the transport. Studio leaves
// it off (the pad settles to the playhead); the animation tab turns it on.
export default function PulsePad({
  audioRef,
  curve,
  segStart = 0,
  winLen = 1,
  color,
  playing,
  idleLoop = false,
}: PulsePadProps) {
  const dotRef = useRef<HTMLDivElement>(null);

  function valueAt(time: number): number {
    if (!curve || !curve.length || winLen <= 0) return 0;
    const f = Math.max(0, Math.min(1, (time - segStart) / winLen));
    return curve[Math.min(curve.length - 1, Math.round(f * (curve.length - 1)))] || 0;
  }

  function paint(v: number) {
    const dot = dotRef.current;
    if (!dot) return;
    dot.style.transform = `scale(${(0.2 + v * 0.8).toFixed(3)})`;
    dot.style.opacity = (0.2 + v * 0.8).toFixed(3);
    dot.style.boxShadow = `0 0 ${(v * 28).toFixed(1)}px ${color}`;
  }

  useEffect(() => {
    // Playing: follow the shared audio clock.
    if (playing) {
      let raf: number;
      const tick = () => {
        const el = audioRef && audioRef.current;
        paint(valueAt(el ? el.currentTime : segStart));
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }
    // Idle + idleLoop: cycle through the curve over winLen so the pad pulses on its own.
    // Phase comes off the SHARED rAF clock (the document timeline `ts`), NOT a per-pad
    // start time — so every idle pad with the same window stays in lock-step (a signal
    // and its Scope pulse together instead of drifting out of sync).
    if (idleLoop && curve && curve.length) {
      let raf: number;
      const tick = (ts: number) => {
        const phase = winLen > 0 ? (ts / 1000 / winLen) % 1 : 0;
        paint(curve[Math.min(curve.length - 1, Math.round(phase * (curve.length - 1)))] || 0);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }
    // Idle, no loop: settle to the value at the current playhead.
    paint(valueAt(audioRef && audioRef.current ? audioRef.current.currentTime : segStart));
    return undefined;
    // Deliberate deps: the RAF loop reads audioRef/valueAt/paint imperatively; it
    // re-runs only when a render-affecting value (playing/curve/window/colour) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, idleLoop, curve, segStart, winLen, color]);

  return (
    <div className="pulse-pad" style={{ "--accent": color } as CSSProperties}>
      <div className="pulse-dot" ref={dotRef} />
    </div>
  );
}
