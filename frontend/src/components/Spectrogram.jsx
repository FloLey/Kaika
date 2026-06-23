import { useRef } from "react";
import { freqToFrac, fracToFreq, fmtHz, clamp } from "../mel.js";

// Reusable spectrogram with band overlay, draggable min/max handles, playhead,
// and click-to-seek. Used both as a row thumbnail and (large) in the modal.
//
// `winStart`/`winEnd`/`duration` (optional) crop the full PNG horizontally to a
// segment's time window: the image spans [0, duration]; we scale it up by
// duration/window and shift it so [winStart, winEnd] fills the container. The
// frequency (y) axis is untouched, so the band math below is unchanged.
export default function Spectrogram({
  track, frac, onSeek, onBandChange, large, onExpand,
  winStart, winEnd, duration,
}) {
  const ref = useRef(null);
  const { specUrl, minHz, maxHz, fmin, fmax, color } = track;

  const win = duration && winEnd != null && winStart != null
    ? winEnd - winStart : null;
  const cropped = win && win > 0 && win < duration;
  // The image (full track) is scaled to duration/win of the container width;
  // translateX is a percentage of the IMAGE's own width, so the shift that puts
  // the window's start at the left edge is winStart/duration (not winStart/win).
  const imgStyle = cropped
    ? {
        width: (duration / win) * 100 + "%",
        maxWidth: "none",
        transform: `translateX(${-(winStart / duration) * 100}%)`,
      }
    : undefined;

  const maxFrac = freqToFrac(maxHz, fmin, fmax); // 0..1 from bottom
  const minFrac = freqToFrac(minHz, fmin, fmax);
  const topPct = (1 - maxFrac) * 100; // removed region above max
  const botPct = minFrac * 100; // removed region below min

  function yToFreq(clientY) {
    const r = ref.current.getBoundingClientRect();
    const fracFromBottom = clamp(1 - (clientY - r.top) / r.height, 0, 1);
    return fracToFreq(fracFromBottom, fmin, fmax);
  }

  function startDrag(which, e) {
    e.stopPropagation();
    e.preventDefault();
    const move = (ev) => {
      let hz = yToFreq(ev.clientY);
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

  function clickSeek(e) {
    const r = ref.current.getBoundingClientRect();
    onSeek(clamp((e.clientX - r.left) / r.width, 0, 1));
  }

  return (
    <div
      className={"spec" + (large ? " large" : "")}
      ref={ref}
      style={{ "--accent": color }}
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
          onClick={(e) => { e.stopPropagation(); onExpand(); }}
        >
          ⤢
        </button>
      )}
    </div>
  );
}
