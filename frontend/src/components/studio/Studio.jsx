import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import SegmentRail from "./SegmentRail.jsx";
import SignalCard from "./SignalCard.jsx";
import AnimationCanvas from "../animation/AnimationCanvas.jsx";
import OutputSettings from "../animation/OutputSettings.jsx";
import VolumeControl from "./VolumeControl.jsx";
import { engine } from "../../lib/audio.js";
import { STEM_META, seedSignal } from "../../lib/segments.js";
import { fmtTime } from "../../lib/mel.js";

// Stage 3 — the studio. Owns all playback/ephemeral state (rail open, what's
// playing, the full-mix reference clock, the per-signal audio registry) and the
// per-segment signal edits. App owns the project (segments/activeSegId) and
// passes setters down. Unmounting (leaving the studio) tears the audio graph
// down via the cleanup effect, so App never reaches into these internals.
export default function Studio({
  segments, setSegments, activeSegId, setActiveSegId, stems, duration, job,
  output, setOutput, onEditSplit,
}) {
  const [railOpen, setRailOpen] = useState(true);
  const [tab, setTab] = useState("signals");   // "signals" | "animation"
  const [showOutput, setShowOutput] = useState(false);   // output-settings modal
  const [allPlaying, setAllPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const [volume, setVolume] = useState(1);      // full-mix playback volume (0..1)
  const [clockT, setClockT] = useState(0);     // playhead within the segment (s)
  const [, setPlaying] = useState(() => new Set());   // tracked for solo bookkeeping
  const audioEls = useRef(new Map());
  const refAudio = useRef(null);   // clean full-mix reference for "play segment"

  // Fullscreen the WHOLE studio panel (timeline + canvas + output modal + tabs), not
  // just the canvas — so the segment transport stays visible and the settings modal,
  // which lives in this subtree, still renders on top in fullscreen.
  const studioMainRef = useRef(null);
  const [isFull, setIsFull] = useState(false);
  useEffect(() => {
    const onFs = () => setIsFull(document.fullscreenElement === studioMainRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
  const toggleFullscreen = useCallback(() => {
    const el = studioMainRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.().catch(() => {});
  }, []);

  const activeSeg = useMemo(
    () => segments.find((s) => s.id === activeSegId) || null,
    [segments, activeSegId]
  );
  const winStart = activeSeg ? activeSeg.start : 0;
  const winEnd = activeSeg ? activeSeg.end : duration;
  const segLen = Math.max(0.001, winEnd - winStart);

  // Seek the shared segment clock to `t` seconds within the segment (0..segLen).
  const seek = useCallback((t) => {
    const a = refAudio.current;
    if (!a) return;
    const clamped = Math.min(Math.max(t, 0), segLen);
    a.currentTime = winStart + clamped;
    setClockT(clamped);
  }, [winStart, segLen]);

  // Tear down the Web Audio graph when leaving the studio.
  useEffect(() => () => { engine.reset(); audioEls.current.clear(); }, []);

  // Volume: scale the full-mix reference element. The transport still runs (the
  // clock advances, so the simulation + pulses keep animating) regardless.
  useEffect(() => {
    if (refAudio.current) refAudio.current.volume = volume;
  }, [volume]);

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
    setClockT(0);
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

  // The animation graph is a whole-segment field (segment.graph); patch it and let
  // App's autosave persist it alongside signals.
  const setActiveGraph = useCallback((graph) => {
    setSegments((prev) =>
      prev.map((s) => (s.id === activeSegId ? { ...s, graph } : s))
    );
  }, [activeSegId, setSegments]);

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
      <div className={"studio-main" + (isFull ? " full" : "")} ref={studioMainRef}>
        <audio
          ref={refAudio}
          src={job ? `/audio/${job}/original` : ""}
          preload="auto"
          onPlay={() => setAllPlaying(true)}
          onPause={() => setAllPlaying(false)}
          onEnded={() => setAllPlaying(false)}
          onTimeUpdate={(e) => {
            const ct = e.target.currentTime;
            if (ct >= winEnd) {
              if (loop) {
                e.target.currentTime = winStart;   // restart the segment
                setClockT(0);
              } else {
                e.target.pause();
                e.target.currentTime = winEnd;
                setClockT(segLen);
              }
              return;
            }
            setClockT(Math.max(0, ct - winStart));
          }}
        />
        <div className="results-head">
          <span className="section-title">
            {activeSeg ? activeSeg.label.toUpperCase() : "SEGMENT"} ·{" "}
            {tab === "signals" ? "EXTRACT SIGNALS BY TRACK" : "CREATE ANIMATION"}
          </span>
          <div className="controls">
            <button className="btn sm" onClick={onEditSplit}>↩ edit split</button>
            <button
              className="btn on seg-play"
              onClick={playAll}
              title={allPlaying ? "Pause" : "Play segment"}
              aria-label={allPlaying ? "Pause" : "Play segment"}
            >
              {allPlaying ? "❚❚" : "▶"}
            </button>
            <input
              className="seg-timeline"
              type="range"
              min={0}
              max={segLen}
              step={0.01}
              value={Math.min(clockT, segLen)}
              onChange={(e) => seek(parseFloat(e.target.value))}
              title="segment timeline — scrub to navigate"
            />
            <span className="seg-time">{fmtTime(clockT)} / {fmtTime(segLen)}</span>
            <VolumeControl value={volume} onChange={setVolume} />
            <label className="loop-toggle" title="Loop the segment">
              <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
              loop
            </label>
          </div>
        </div>

        {tab === "signals"
          ? activeSeg && STEM_META.filter((m) => stems[m.key]).map((stem) => {
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
          })
          : activeSeg && (
            <AnimationCanvas
              key={activeSeg.id}
              segment={activeSeg}
              stems={stems}
              job={job}
              output={output}
              groupClock={refAudio}
              groupPlaying={allPlaying}
              isFullscreen={isFull}
              onToggleFullscreen={toggleFullscreen}
              onOpenOutput={() => setShowOutput(true)}
              onGraphChange={setActiveGraph}
            />
          )}

        {showOutput && (
          <OutputSettings
            output={output}
            onChange={setOutput}
            onClose={() => setShowOutput(false)}
          />
        )}

        <nav className="mode-bar">
          <button
            className={"mode-tab" + (tab === "signals" ? " on" : "")}
            onClick={() => setTab("signals")}
          >
            extract signals by track
          </button>
          <button
            className={"mode-tab" + (tab === "animation" ? " on" : "")}
            onClick={() => setTab("animation")}
          >
            create animation
          </button>
        </nav>
      </div>
    </div>
  );
}
