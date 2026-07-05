import { useSyncExternalStore } from "react";
import type { ChangeEvent } from "react";
import { fmtTime } from "../../lib/mel";

interface TransportClockProps {
  subscribe: (fn: () => void) => () => void;
  getClockT: () => number;
  segLen: number;
  seek: (t: number) => void;
}

// The transport's timeline slider + time readout — the ONLY part of the studio that
// re-renders on the playhead's ~4×/s timeupdate ticks. It subscribes to the playback
// hook's external clock store so the heavy siblings (SignalCards, AnimationCanvas)
// stay untouched during playback.
export default function TransportClock({ subscribe, getClockT, segLen, seek }: TransportClockProps) {
  const clockT = useSyncExternalStore(subscribe, getClockT);
  return (
    <>
      <input
        className="seg-timeline"
        type="range"
        min={0}
        max={segLen}
        step={0.01}
        value={Math.min(clockT, segLen)}
        onChange={(e: ChangeEvent<HTMLInputElement>) => seek(parseFloat(e.target.value))}
        title="segment timeline — scrub to navigate"
      />
      <span className="seg-time">
        {fmtTime(clockT)} / {fmtTime(segLen)}
      </span>
    </>
  );
}
