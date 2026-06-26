import { useEffect, useRef, useState } from "react";
import { fmtTime } from "../../lib/mel.js";
import { LABELS, labelColor, splitAt, mergeWithPrev, moveBoundary } from "../../lib/segments.js";

// Step 2 — review and edit the proposed split before opening the studio.
// The full-mix spectrogram + vocal-activity envelope are the backdrop; play the
// track to listen, click to seek, drag the vertical handles to move boundaries,
// and split at the playhead (or double-click) to add a cut. Each segment can be
// relabelled or merged into its neighbor.
export default function ReviewStep({
  specUrl,
  audioUrl,
  duration,
  segments,
  setSegments,
  vocalEnvelope,
  envelopeTimes,
  onValidate,
  onBack,
}) {
  const railRef = useRef(null);
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);

  const timeAtX = (clientX) => {
    const r = railRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * duration;
  };

  function togglePlay() {
    const el = audioRef.current;
    if (el.paused) el.play().catch(() => {});
    else el.pause();
  }

  // Space toggles play/pause from anywhere on this screen.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.key === " " || e.code === "Space") && e.target.tagName !== "SELECT") {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function seekTo(t) {
    const el = audioRef.current;
    if (el && isFinite(el.duration)) el.currentTime = Math.max(0, Math.min(t, duration));
  }

  function startDragBoundary(i, e) {
    e.stopPropagation();
    e.preventDefault();
    const move = (ev) => setSegments((segs) => moveBoundary(segs, i, timeAtX(ev.clientX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const splitHere = () => setSegments((segs) => splitAt(segs, cur));

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
          {playing ? "❚❚" : "▶"}
        </button>
        <div
          className="bar"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            seekTo(((e.clientX - r.left) / r.width) * duration);
          }}
        >
          <div className="fill" style={{ width: playFrac + "%" }} />
        </div>
        <div className="time">
          {fmtTime(cur)} / {fmtTime(duration)}
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
        onDoubleClick={(e) => setSegments((segs) => splitAt(segs, timeAtX(e.clientX)))}
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
              style={{ left: left + "%", width: width + "%", "--c": labelColor(s.label) }}
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

        <div className="playhead" style={{ left: playFrac + "%" }} />
      </div>

      <div className="seg-list">
        {segments.map((s, i) => (
          <div className="seg-row" key={s.id} style={{ "--c": labelColor(s.label) }}>
            <button
              className="seg-play"
              title="Play from here"
              onClick={() => {
                seekTo(s.start);
                audioRef.current?.play().catch(() => {});
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

      <audio
        ref={audioRef}
        src={audioUrl}
        preload="metadata"
        onTimeUpdate={(e) => setCur(e.target.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
    </div>
  );
}
