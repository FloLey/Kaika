// Signal lanes under the waveform: SEE what drives the simulation.
// RMS + flux as area curves, the band split as a stacked area, onsets and the
// beat grid as ticks, timeline directives as draggable pins.
import { useEffect, useRef } from "react";
import { Signals, TimelineDirective } from "../api";

interface Props {
  signals: Signals;
  duration: number;
  timeline: TimelineDirective[];
  playhead: number;
  onSeek: (t: number) => void;
  onMovePin: (index: number, t: number) => void;
}

const LANE_H = 26;

export default function Lanes({ signals, duration, timeline, playhead,
                                onSeek, onMovePin }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drag = useRef<number | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const X = (t: number) => (t / duration) * w;

    const area = (vals: number[], y0: number, color: string) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, y0 + LANE_H);
      vals.forEach((v, i) => {
        ctx.lineTo((i / vals.length) * w, y0 + LANE_H - v * LANE_H);
      });
      ctx.lineTo(w, y0 + LANE_H);
      ctx.closePath();
      ctx.fill();
    };
    const lane_label = (txt: string, y0: number) => {
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      ctx.font = "9px sans-serif";
      ctx.fillText(txt, 4, y0 + 9);
    };

    // Lane 1: RMS (filled) + flux (line)
    area(signals.rms, 0, "rgba(143,199,188,0.35)");
    ctx.strokeStyle = "rgba(224,164,88,0.8)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    signals.flux.forEach((v, i) => {
      const x = (i / signals.flux.length) * w;
      const y = LANE_H - v * LANE_H;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    lane_label("rms / flux", 0);

    // Lane 2: band split, stacked
    const y2 = LANE_H + 4;
    const { low, mid, high } = signals.bands;
    ctx.save();
    for (let i = 0; i < low.length; i++) {
      const x = (i / low.length) * w;
      const bw = w / low.length + 1;
      const tot = (low[i] + mid[i] + high[i]) || 1;
      const hl = (low[i] / tot) * LANE_H;
      const hm = (mid[i] / tot) * LANE_H;
      const hh = LANE_H - hl - hm;
      ctx.fillStyle = "rgba(184,74,116,0.5)";
      ctx.fillRect(x, y2 + LANE_H - hl, bw, hl);
      ctx.fillStyle = "rgba(108,74,140,0.5)";
      ctx.fillRect(x, y2 + LANE_H - hl - hm, bw, hm);
      ctx.fillStyle = "rgba(63,163,155,0.5)";
      ctx.fillRect(x, y2, bw, hh);
    }
    ctx.restore();
    lane_label("bands low/mid/high", y2);

    // Lane 3: timeline pins
    const y3 = 2 * (LANE_H + 4);
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.strokeRect(0, y3, w, LANE_H);
    timeline.forEach((d, i) => {
      const t = typeof d.at === "number" ? d.at
        : (Array.isArray(d.between) && typeof d.between[0] === "number"
           ? d.between[0] as number : null);
      const anchored = t === null;
      const tt = t ?? 0;
      const x = X(Math.min(tt, duration));
      ctx.fillStyle = anchored ? "#8fc7bc" : "#e0a458";
      ctx.beginPath();
      ctx.moveTo(x, y3 + 2);
      ctx.lineTo(x - 5, y3 + 12);
      ctx.lineTo(x + 5, y3 + 12);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.font = "9px sans-serif";
      ctx.fillText(anchored ? String(d.at ?? "") : d.action, x + 6, y3 + 12);
      if (d.action === "set" && Array.isArray(d.between)
          && typeof d.between[0] === "number" && typeof d.between[1] === "number") {
        ctx.fillStyle = "rgba(224,164,88,0.2)";
        ctx.fillRect(X(d.between[0] as number), y3,
                     X((d.between[1] as number) - (d.between[0] as number)), LANE_H);
      }
      void i;
    });
    lane_label("timeline", y3);

    // playhead through everything
    const x = X(Math.min(playhead, duration));
    ctx.strokeStyle = "rgba(255,255,255,0.8)";
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }, [signals, duration, timeline, playhead]);

  const toSec = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.max(0, Math.min(duration,
      ((clientX - r.left) / r.width) * duration));
  };
  const pinAt = (clientX: number, clientY: number): number | null => {
    const r = ref.current!.getBoundingClientRect();
    const y3 = 2 * (LANE_H + 4);
    if (clientY - r.top < y3) return null;
    for (let i = 0; i < timeline.length; i++) {
      const d = timeline[i];
      if (typeof d.at !== "number") continue;
      const x = (d.at / duration) * r.width + r.left;
      if (Math.abs(clientX - x) <= 6) return i;
    }
    return null;
  };

  return (
    <canvas ref={ref} className="lanes"
      style={{ width: "100%", height: 3 * (LANE_H + 4) }}
      onMouseDown={(e) => { drag.current = pinAt(e.clientX, e.clientY); }}
      onMouseMove={(e) => {
        if (drag.current != null)
          onMovePin(drag.current, Math.round(toSec(e.clientX) * 100) / 100);
      }}
      onMouseUp={(e) => {
        if (drag.current != null) { drag.current = null; return; }
        onSeek(toSec(e.clientX));
      }}
      onMouseLeave={() => { drag.current = null; }}
    />
  );
}
