import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import SegmentRail from "./SegmentRail.jsx";
import SignalCard from "./SignalCard.jsx";
import { engine } from "../audio.js";
import { STEM_META, seedSignal } from "../segments.js";

// Stage 3 — the studio. Owns all playback/ephemeral state (rail open, what's
// playing, the full-mix reference clock, the per-signal audio registry) and the
// per-segment signal edits. App owns the project (segments/activeSegId) and
// passes setters down. Unmounting (leaving the studio) tears the audio graph
// down via the cleanup effect, so App never reaches into these internals.
export default function Studio({
  segments, setSegments, activeSegId, setActiveSegId, stems, duration, job,
  onEditSplit,
}) {
  const [railOpen, setRailOpen] = useState(true);
  const [allPlaying, setAllPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [, setPlaying] = useState(() => new Set());   // tracked for solo bookkeeping
  const audioEls = useRef(new Map());
  const refAudio = useRef(null);   // clean full-mix reference for "play segment"

  const activeSeg = useMemo(
    () => segments.find((s) => s.id === activeSegId) || null,
    [segments, activeSegId]
  );
  const winStart = activeSeg ? activeSeg.start : 0;
  const winEnd = activeSeg ? activeSeg.end : duration;

  // Tear down the Web Audio graph when leaving the studio.
  useEffect(() => () => { engine.reset(); audioEls.current.clear(); }, []);

  const registerAudio = useCallback((id, el) => {
    if (el) audioEls.current.set(id, el);
    else audioEls.current.delete(id);
  }, []);

  const onPlayingChange = useCallback((id, isPlaying) => {
    setPlaying((prev) => {
      const next = new Set(prev);
      if (isPlaying) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  // Solo: playing one signal pauses the others — and stops the full-mix
  // "play segment" audio so a single band can't play on top of the whole segment.
  const handleSolo = useCallback((id) => {
    audioEls.current.forEach((el, k) => { if (k !== id) el.pause(); });
    if (refAudio.current) refAudio.current.pause();
  }, []);

  // Play the whole segment once: ONE audio element (the original full mix) is
  // the clock + the sound. Every pulse pad reads this same clock (see SignalCard
  // groupClock), so all pulses animate together with no duplicate/overlapping
  // audio. Toggles play/pause of that single element.
  const playAll = useCallback(() => {
    const ref = refAudio.current;
    if (!ref) return;
    audioEls.current.forEach((el) => el.pause());   // stop any solo band
    if (!ref.paused) { ref.pause(); return; }
    const start = activeSeg ? activeSeg.start : 0;
    const begin = () => {
      if (isFinite(ref.duration) && (ref.currentTime < start || ref.currentTime >= winEnd - 0.02)) {
        ref.currentTime = start;
      }
      ref.play().catch(() => {});
    };
    // The full mix is a compressed file; on the first play it may not be buffered
    // yet (the WAV stems are). Wait for it to be playable instead of starting silent.
    if (ref.readyState >= 2) begin();
    else {
      ref.addEventListener("canplay", begin, { once: true });
      ref.load();
    }
  }, [activeSeg, winEnd]);

  function selectSegment(id) {
    audioEls.current.forEach((el) => el.pause());
    if (refAudio.current) refAudio.current.pause();
    setPlaying(new Set());
    setAllPlaying(false);
    setActiveSegId(id);
  }

  // ---- per-segment signal edits --------------------------------------------
  const editActiveSignals = useCallback((fn) => {
    setSegments((prev) =>
      prev.map((s) => (s.id === activeSegId ? { ...s, signals: fn(s.signals) } : s))
    );
  }, [activeSegId, setSegments]);

  const updateSignal = useCallback((id, p) => {
    editActiveSignals((sigs) => sigs.map((s) => (s.id === id ? { ...s, ...p } : s)));
  }, [editActiveSignals]);

  const addSignal = useCallback((stemKey) => {
    editActiveSignals((sigs) => {
      const meta = STEM_META.find((m) => m.key === stemKey);
      const n = sigs.filter((s) => s.stemKey === stemKey).length + 1;
      const name = `${(meta?.name || stemKey).toLowerCase()} ${n}`;
      return [...sigs, seedSignal(stems, name, stemKey)];
    });
  }, [editActiveSignals, stems]);

  const removeSignal = useCallback((id) => {
    engine.remove(id);
    audioEls.current.delete(id);
    editActiveSignals((sigs) => sigs.filter((s) => s.id !== id));
  }, [editActiveSignals]);

  return (
    <div className={"studio" + (railOpen ? "" : " rail-collapsed")}>
      {railOpen ? (
        <SegmentRail
          segments={segments}
          activeSegId={activeSegId}
          onSelect={selectSegment}
          onCollapse={() => setRailOpen(false)}
        />
      ) : (
        <button className="rail-reopen" title="Show segments" onClick={() => setRailOpen(true)}>
          ☰
        </button>
      )}
      <div className="studio-main">
        <audio
          ref={refAudio}
          src={job ? `/audio/${job}/original` : ""}
          preload="auto"
          onPlay={() => setAllPlaying(true)}
          onPause={() => setAllPlaying(false)}
          onEnded={() => setAllPlaying(false)}
          onTimeUpdate={(e) => {
            if (e.target.currentTime >= winEnd) {
              if (loop) {
                e.target.currentTime = winStart;   // restart the segment
              } else {
                e.target.pause();
                e.target.currentTime = winEnd;
              }
            }
          }}
        />
        <div className="results-head">
          <span className="section-title">
            {activeSeg ? activeSeg.label.toUpperCase() : "SEGMENT"} · EXTRACT SIGNALS BY TRACK
          </span>
          <div className="controls">
            <button className="btn sm" onClick={onEditSplit}>↩ edit split</button>
            <button className="btn on" onClick={playAll}>
              {allPlaying ? "❚❚ pause" : "▶ play segment"}
            </button>
            <label className="loop-toggle" title="Loop the segment">
              <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
              loop
            </label>
          </div>
        </div>
        {activeSeg && STEM_META.filter((m) => stems[m.key]).map((stem) => {
          const sigs = activeSeg.signals.filter((s) => s.stemKey === stem.key);
          return (
            <div className="track-group" key={stem.key} style={{ "--accent": stem.color }}>
              <div className="track-group-head">
                <span className="track-name"><span className="dot" />{stem.name}</span>
                <button className="btn sm" onClick={() => addSignal(stem.key)}>+ add band</button>
              </div>
              {sigs.length === 0 && (
                <div className="track-empty">no signals — add a frequency band to extract one</div>
              )}
              <div className="signals">
                {sigs.map((sg) => (
                  <SignalCard
                    key={sg.id}
                    signal={sg}
                    stems={stems}
                    segStart={activeSeg.start}
                    segEnd={activeSeg.end}
                    duration={duration}
                    jobId={job}
                    onChange={updateSignal}
                    onRemove={removeSignal}
                    registerAudio={registerAudio}
                    onSolo={handleSolo}
                    onPlayingChange={onPlayingChange}
                    groupClock={refAudio}
                    groupPlaying={allPlaying}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
