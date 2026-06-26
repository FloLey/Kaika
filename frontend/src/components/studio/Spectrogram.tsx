import { useRef } from "react";
import type { CSSProperties, MouseEvent, PointerEvent as RPointerEvent } from "react";
import { freqToFrac, fracToFreq, fmtHz, clamp } from "../../lib/mel";

interface TrackSpec {
  specUrl: string;
  minHz: number;
  maxHz: number;
  fmin: number;
  fmax: number;
  color: string;
}

interface SpectrogramProps {
  track: TrackSpec;
  frac: number;
  onSeek: (f: number) => void;
  onBandChange: (min: number, max: number) => void;
  large?: boolean;
  onExpand?: () => void;
  winStart?: number;
  winEnd?: number;
  duration?: number;
}

// Reusable spectrogram with band overlay, draggable min/max handles, playhead,
// and click-to-seek. Used both as a row thumbnail and (large) in the modal.
export default function Spectrogram({
  track,
  frac,
  onSeek,
  onBandChange,
  large,
  onExpand,
  winStart,
  winEnd,
  duration,
}: SpectrogramProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { specUrl, minHz, maxHz, fmin, fmax, color } = track;

  const win = duration && winEnd != null && winStart != null ? winEnd - winStart : null;
  const cropped = win != null && win > 0 && win < duration!;
  // The image (full track) is scaled to duration/win of the container width;
  // translateX is a percentage of the IMAGE's own width, so the shift that puts
  // the window's start at the left edge is winStart/duration (not winStart/win).
  const imgStyle: CSSProperties | undefined = cropped
    ? {
        width: (duration! / win!) * 100 + "%",
        maxWidth: "none",
        transform: `translateX(${-(winStart! / duration!) * 100}%)`,
      }
    : undefined;

  const maxFrac = freqToFrac(maxHz, fmin, fmax); // 0..1 from bottom
  const minFrac = freqToFrac(minHz, fmin, fmax);
  const topPct = (1 - maxFrac) * 100; // removed region above max
  const botPct = minFrac * 100; // removed region below min

  function yToFreq(clientY: number): number {
    const r = ref.current!.getBoundingClientRect();
    const fracFromBottom = clamp(1 - (clientY - r.top) / r.height, 0, 1);
    return fracToFreq(fracFromBottom, fmin, fmax);
  }

  function startDrag(which: "min" | "max", e: RPointerEvent) {
    e.stopPropagation();
    e.preventDefault();
    const move = (ev: PointerEvent) => {
      const hz = yToFreq(ev.clientY);
      if (which === "min") onBandChange(Math.min(hz, maxHz), maxHz);
      else onBandChange(minHz, Math.max(hz, minHz));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function clickSeek(e: MouseEvent) {
    const r = ref.current!.getBoundingClientRect();
    onSeek(clamp((e.clientX - r.left) / r.width, 0, 1));
  }

  return (
    <div
      className={"spec" + (large ? " large" : "")}
      ref={ref}
      style={{ "--accent": color } as CSSProperties}
      onClick={clickSeek}
    >
      <img src={specUrl} alt="spectrogram" draggable={false} style={imgStyle} />
      <div className="band-dim" style={{ top: 0, height: topPct + "%" }} />
      <div className="band-dim" style={{ bottom: 0, height: botPct + "%" }} />

      <div
        className="band-handle max"
        style={{ top: topPct + "%" }}
        onPointerDown={(e) => startDrag("max", e)}
        onClick={(e) => e.stopPropagation()}
        title="Drag to set max frequency"
      >
        {large && <span className="hztag">max {fmtHz(maxHz)}</span>}
      </div>
      <div
        className="band-handle min"
        style={{ bottom: botPct + "%" }}
        onPointerDown={(e) => startDrag("min", e)}
        onClick={(e) => e.stopPropagation()}
        title="Drag to set min frequency"
      >
        {large && <span className="hztag">min {fmtHz(minHz)}</span>}
      </div>

      <div className="playhead" style={{ left: frac * 100 + "%" }} />

      {onExpand && (
        <button
          className="expand"
          title="Open large view"
          onClick={(e) => {
            e.stopPropagation();
            onExpand();
          }}
        >
          ⤢
        </button>
      )}
    </div>
  );
}
