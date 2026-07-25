import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  CSSProperties,
  Dispatch,
  PointerEvent as RPointerEvent,
  SetStateAction,
  SyntheticEvent,
} from "react";
import { fmtTime } from "../../lib/mel";
import { LABELS, labelColor, mergeWithPrev, moveBoundary } from "../../lib/segments";
import * as transport from "../../lib/transport";
import type { Segment } from "../../lib/types";

// The playhead, as three leaves that subscribe to the shared transport's position.
// Module-scope on purpose: declared inside the render body they would be a NEW
// component type every render, so React would unmount and remount them per tick —
// worse than the whole-tree re-render they exist to avoid.
const useSongPos = () =>
  useSyncExternalStore(transport.subscribePosition, transport.positionSong, transport.positionSong);
const pct = (t: number, duration: number) => (duration ? (t / duration) * 100 : 0);

function SharedFill({ duration }: { duration: number }) {
  return <div className="fill" style={{ width: pct(useSongPos(), duration) + "%" }} />;
}
function SharedHead({ duration }: { duration: number }) {
  return <div className="playhead" style={{ left: pct(useSongPos(), duration) + "%" }} />;
}
function SharedClock({ duration }: { duration: number }) {
  return (
    <>
      {fmtTime(useSongPos())} / {fmtTime(duration)}
    </>
  );
}

// Step 2 — review and edit the proposed split before opening the studio.
// The full-mix spectrogram + vocal-activity envelope are the backdrop; play the
// track to listen, click to seek, drag the vertical handles to move boundaries,
// and split at the playhead (or double-click) to add a cut. Each segment can be
// relabelled or merged into its neighbor.
interface ReviewStepProps {
  specUrl: string;
  audioUrl: string;
  duration: number;
  segments: Segment[];
  setSegments: Dispatch<SetStateAction<Segment[]>>;
  // Splitting clones the segment's composition (both project halves change), so
  // the handler lives in App where the pool's setter is.
  onSplitAt: (t: number) => void;
  vocalEnvelope: number[];
  envelopeTimes: number[];
  onValidate: () => void;
  onBack: () => void;
  // ?ui=next — play through the shell's transport instead of a private <audio>, so
  // the music survives leaving this screen.
  shared?: boolean;
}

export default function ReviewStep({
  specUrl,
  audioUrl,
  duration,
  segments,
  setSegments,
  onSplitAt,
  vocalEnvelope,
  envelopeTimes,
  onValidate,
  onBack,
  shared = false,
}: ReviewStepProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  // ?ui=next — the shell's transport, which keeps playing across stages. It also
  // fixes what this screen does wrong on its own: `setCur` on every `timeupdate`
  // re-renders the WHOLE review tree ~4×/s (every segment row, the rail, the
  // envelope), which is exactly the cost useStudioPlayback's comment warns about.
  // In shared mode the playhead is subscribed by two leaf components instead.
  const sharedPlaying = useSyncExternalStore(
    transport.subscribe,
    transport.snapshot,
    transport.snapshot
  ).playing;
  const isPlaying = shared ? sharedPlaying : playing;

  const timeAtX = (clientX: number) => {
    const r = railRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * duration;
  };

  // Memoized because the Space-key effect depends on it: it now closes over
  // `shared`, so a fresh identity every render would re-bind the listener per
  // render (and an empty dep array would capture the first `shared` forever).
  const togglePlay = useCallback(() => {
    if (shared) return transport.toggle();
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => {});
    else el.pause();
  }, [shared]);

  // Space toggles play/pause from anywhere on this screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === " " || e.code === "Space") && (e.target as HTMLElement).tagName !== "SELECT") {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay]);

  function seekTo(t: number) {
    if (shared) return transport.seekSong(Math.max(0, Math.min(t, duration)));
    const el = audioRef.current;
    if (el && isFinite(el.duration)) el.currentTime = Math.max(0, Math.min(t, duration));
  }

  function startDragBoundary(i: number, e: RPointerEvent) {
    e.stopPropagation();
    e.preventDefault();
    const move = (ev: PointerEvent) =>
      setSegments((segs) => moveBoundary(segs, i, timeAtX(ev.clientX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // Read the playhead imperatively in shared mode: it is deliberately not state
  // here, so there is nothing to read off a render.
  const splitHere = () => onSplitAt(shared ? transport.positionSong() : cur);

  // Vocal-activity envelope as a stretched polyline.
  const envPath = (() => {
    if (!vocalEnvelope || !vocalEnvelope.length || !duration) return "";
    const step = Math.max(1, Math.floor(vocalEnvelope.length / 800));
    const pts = [];
    for (let i = 0; i < vocalEnvelope.length; i += step) {
      const t = envelopeTimes?.[i] ?? (i / vocalEnvelope.length) * duration;
      const x = (t / duration) * 1000;
      const y = (1 - vocalEnvelope[i]) * 100;
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    return "M" + pts.join(" L");
  })();

  const playFrac = duration ? (cur / duration) * 100 : 0;

  return (
    <div className="step review-step">
      <div className="results-head">
        <span className="section-title">REVIEW SPLIT · {segments.length} segments</span>
        <div className="controls">
          <button className="btn sm" onClick={onBack}>
            ↩ back
          </button>
          <button className="btn on" onClick={onValidate}>
            ✓ validate split
          </button>
        </div>
      </div>

      <div className="review-transport">
        <button className="play" onClick={togglePlay}>
          {isPlaying ? "❚❚" : "▶"}
        </button>
        <div
          className="bar"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            seekTo(((e.clientX - r.left) / r.width) * duration);
          }}
        >
          {shared ? (
            <SharedFill duration={duration} />
          ) : (
            <div className="fill" style={{ width: playFrac + "%" }} />
          )}
        </div>
        <div className="time">
          {shared ? (
            <SharedClock duration={duration} />
          ) : (
            <>
              {fmtTime(cur)} / {fmtTime(duration)}
            </>
          )}
        </div>
        <button className="btn sm" onClick={splitHere} title="Add a cut at the playhead">
          ✂ split at playhead
        </button>
      </div>

      <div className="hint">
        Play to listen · click the timeline to seek · drag a boundary to move it · double-click (or
        “split at playhead”) to add a cut.
      </div>

      <div
        className="rail"
        ref={railRef}
        onClick={(e) => seekTo(timeAtX(e.clientX))}
        onDoubleClick={(e) => onSplitAt(timeAtX(e.clientX))}
      >
        <img className="rail-img" src={specUrl} alt="full mix" draggable={false} />
        <svg className="rail-env" viewBox="0 0 1000 100" preserveAspectRatio="none">
          <path d={envPath} />
        </svg>

        {/* segment label bands */}
        {segments.map((s) => {
          const left = (s.start / duration) * 100;
          const width = ((s.end - s.start) / duration) * 100;
          return (
            <div
              key={s.id}
              className="rail-seg"
              style={
                {
                  left: left + "%",
                  width: width + "%",
                  "--c": labelColor(s.label),
                } as CSSProperties
              }
            >
              <span className="rail-seg-label">{s.label}</span>
            </div>
          );
        })}

        {/* draggable interior boundaries */}
        {segments.slice(1).map((s, idx) => {
          const i = idx + 1;
          return (
            <div
              key={"b" + s.id}
              className="rail-bound"
              style={{ left: (s.start / duration) * 100 + "%" }}
              onPointerDown={(e) => startDragBoundary(i, e)}
              onClick={(e) => e.stopPropagation()}
              title="Drag to move boundary"
            />
          );
        })}

        {shared ? (
          <SharedHead duration={duration} />
        ) : (
          <div className="playhead" style={{ left: playFrac + "%" }} />
        )}
      </div>

      <div className="seg-list">
        {segments.map((s, i) => (
          <div
            className="seg-row"
            key={s.id}
            style={{ "--c": labelColor(s.label) } as CSSProperties}
          >
            <button
              className="seg-play"
              title="Play from here"
              onClick={() => {
                seekTo(s.start);
                if (shared) transport.play();
                else audioRef.current?.play().catch(() => {});
              }}
            >
              ▶
            </button>
            <select
              className="seg-select"
              value={s.label}
              onChange={(e) =>
                setSegments((segs) =>
                  segs.map((x) => (x.id === s.id ? { ...x, label: e.target.value } : x))
                )
              }
            >
              {LABELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
            <span className="seg-range">
              {fmtTime(s.start)} – {fmtTime(s.end)}
            </span>
            <span className="seg-dur">{fmtTime(s.end - s.start)}</span>
            <button
              className="iconbtn"
              disabled={i === 0}
              title="Merge into the previous segment"
              onClick={() => setSegments((segs) => mergeWithPrev(segs, s.id))}
            >
              ⌫
            </button>
          </div>
        ))}
      </div>

      {!shared && (
        <audio
          ref={audioRef}
          src={audioUrl}
          preload="metadata"
          onTimeUpdate={(e: SyntheticEvent<HTMLAudioElement>) =>
            setCur(e.currentTarget.currentTime)
          }
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />
      )}
    </div>
  );
}
