// The transport, docked once at the bottom of the shell and alive on every stage.
//
// Its whole point is continuity: because `lib/transport` owns the <audio> element
// outside the React tree, stepping review → studio → export doesn't stop the music
// or lose the position. The bar is just a view over that.
//
// The scrub is over the WHOLE song with the segment boundaries ticked, so the shape
// of the track is visible from every stage — the current UI only ever shows you the
// segment you happen to be inside.

import { useSyncExternalStore } from "react";
import type { PointerEvent as RPointerEvent } from "react";
import { fmtTime } from "../../lib/mel";
import { labelColor } from "../../lib/segments";
import * as transport from "../../lib/transport";
import type { Segment } from "../../lib/types";

function useSnapshot() {
  return useSyncExternalStore(transport.subscribe, transport.snapshot, transport.snapshot);
}

// Split out so only THIS component re-renders on the ~4 Hz position tick — the same
// discipline `TransportClock` follows in the current studio.
function Readout({ duration }: { duration: number }) {
  const pos = useSyncExternalStore(
    transport.subscribePosition,
    transport.positionSong,
    transport.positionSong
  );
  return (
    <span className="tbar-time mono">
      {fmtTime(pos)} / {fmtTime(duration)}
    </span>
  );
}

function Playhead({ duration }: { duration: number }) {
  const pos = useSyncExternalStore(
    transport.subscribePosition,
    transport.positionSong,
    transport.positionSong
  );
  if (!duration) return null;
  return <div className="tbar-head" style={{ left: `${(pos / duration) * 100}%` }} />;
}

export interface TransportBarProps {
  duration: number;
  segments: Segment[];
  activeSegId?: string | null;
  // Clicking a segment band is navigation, not just a seek.
  onSelectSegment?: (id: string) => void;
}

export default function TransportBar({
  duration,
  segments,
  activeSegId,
  onSelectSegment,
}: TransportBarProps) {
  const s = useSnapshot();
  const scrub = (e: RPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (!r.width || !duration) return;
    transport.seekSong(((e.clientX - r.left) / r.width) * duration);
  };

  const windowed = s.windowEnd > 0 && s.windowEnd - s.windowStart < duration - 0.01;

  return (
    <div className="tbar">
      <button
        className="btn sm tbar-play"
        onClick={transport.toggle}
        aria-label={s.playing ? "Pause" : "Play"}
        title={s.playing ? "Pause" : "Play"}
      >
        {s.playing ? "❚❚" : "▶"}
      </button>

      <Readout duration={duration} />

      <div className="tbar-track" onPointerDown={scrub}>
        {/* One band per segment, so the song's structure is legible from any stage. */}
        {duration > 0 &&
          segments.map((seg) => (
            <button
              key={seg.id}
              className={"tbar-seg" + (seg.id === activeSegId ? " on" : "")}
              style={{
                left: `${(seg.start / duration) * 100}%`,
                width: `${((seg.end - seg.start) / duration) * 100}%`,
                ["--c" as string]: labelColor(seg.label),
              }}
              title={`${seg.label} · ${fmtTime(seg.start)}–${fmtTime(seg.end)}`}
              onPointerDown={(e) => {
                e.stopPropagation(); // the band selects; the track behind it seeks
                onSelectSegment?.(seg.id);
              }}
            />
          ))}
        {/* The loop window, when it's narrower than the song. */}
        {windowed && (
          <div
            className="tbar-window"
            style={{
              left: `${(s.windowStart / duration) * 100}%`,
              width: `${((s.windowEnd - s.windowStart) / duration) * 100}%`,
            }}
          />
        )}
        <Playhead duration={duration} />
      </div>

      <label className="tbar-vol" title="Volume">
        <span aria-hidden>🔊</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={s.volume}
          aria-label="Volume"
          onChange={(e) => transport.setVolume(parseFloat(e.target.value))}
        />
      </label>

      <label className="tbar-loop" title="Loop the current window">
        <input
          type="checkbox"
          checked={s.loop}
          onChange={(e) => transport.setLoop(e.target.checked)}
        />
        loop
      </label>

      {/* What the loop is bounded by — the segment you're editing, or the track. */}
      <span className="tbar-scope mono">{windowed ? "segment" : "song"}</span>
    </div>
  );
}
