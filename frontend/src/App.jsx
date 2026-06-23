import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ProjectList from "./components/ProjectList.jsx";
import FluidLab from "./components/FluidLab.jsx";
import UploadStep from "./components/UploadStep.jsx";
import ReviewStep from "./components/ReviewStep.jsx";
import SegmentRail from "./components/SegmentRail.jsx";
import Processing from "./components/Processing.jsx";
import SignalCard from "./components/SignalCard.jsx";
import { engine } from "./audio.js";
import { hydrateSegments, serializeSegments, seedSignal, STEM_META } from "./segments.js";
import * as api from "./api.js";

export default function App() {
  // projects | upload | processing | review | studio | error
  const [step, setStep] = useState("projects");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const [job, setJob] = useState(null);
  const [title, setTitle] = useState("");
  const [duration, setDuration] = useState(0);
  const [originalSpec, setOriginalSpec] = useState("");
  const [stems, setStems] = useState({});

  const [segments, setSegments] = useState([]);
  const [vocalEnvelope, setVocalEnvelope] = useState([]);
  const [envelopeTimes, setEnvelopeTimes] = useState([]);
  const [activeSegId, setActiveSegId] = useState(null);

  const [railOpen, setRailOpen] = useState(true);
  const [playing, setPlaying] = useState(() => new Set());
  const [allPlaying, setAllPlaying] = useState(false);
  const audioEls = useRef(new Map());
  const refAudio = useRef(null);   // clean full-mix reference for "play all"
  const lastSaved = useRef("");

  const activeSeg = useMemo(
    () => segments.find((s) => s.id === activeSegId) || null,
    [segments, activeSegId]
  );
  const winEnd = activeSeg ? activeSeg.end : duration;

  // ---- autosave (debounced) -------------------------------------------------
  useEffect(() => {
    if (!job || (step !== "review" && step !== "studio")) return;
    const payload = { step, segments: serializeSegments(segments) };
    const jsonStr = JSON.stringify(payload);
    if (jsonStr === lastSaved.current) return;
    const t = setTimeout(() => {
      api.saveProject(job, payload)
        .then(() => { lastSaved.current = jsonStr; })
        .catch(() => {});
    }, 800);
    return () => clearTimeout(t);
  }, [segments, step, job]);

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

  // Solo: playing one signal pauses the others.
  const handleSolo = useCallback((id) => {
    audioEls.current.forEach((el, k) => { if (k !== id) el.pause(); });
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
    if (isFinite(ref.duration) && (ref.currentTime < start || ref.currentTime >= winEnd - 0.02)) {
      ref.currentTime = start;
    }
    ref.play().catch(() => {});
  }, [activeSeg, winEnd]);

  function selectSegment(id) {
    audioEls.current.forEach((el) => el.pause());
    if (refAudio.current) refAudio.current.pause();
    setPlaying(new Set());
    setAllPlaying(false);
    setActiveSegId(id);
  }

  // ---- new track: upload + propose -----------------------------------------
  async function handleUpload({ file, youtubeUrl, lyrics, lyricsFile }) {
    setStep("processing");
    setError("");
    try {
      setStatus(file ? "separating stems with demucs…" : "downloading audio from YouTube…");
      const fd = new FormData();
      if (file) fd.append("file", file);
      else if (youtubeUrl) fd.append("youtube_url", youtubeUrl);
      if (lyricsFile) fd.append("lyrics_file", lyricsFile);
      else if (lyrics && lyrics.trim()) fd.append("lyrics", lyrics);
      const data = await api.uploadSong(fd);

      setJob(data.job_id);
      setTitle(data.title || "");
      setDuration(data.duration || 0);
      setStems(data.stems);
      setOriginalSpec(data.stems.original?.spectrogram || "");

      setStatus("analysing structure (lyrics + vocal activity)…");
      const segData = await api.segmentJob(data.job_id);
      setVocalEnvelope(segData.vocal_envelope || []);
      setEnvelopeTimes(segData.envelope_times || []);
      if (segData.duration) setDuration(segData.duration);
      lastSaved.current = "";
      setSegments(hydrateSegments(segData.segments, data.stems));
      setStep("review");
    } catch (e) {
      setError(e.message);
      setStep("error");
    }
  }

  // ---- resume an existing project ------------------------------------------
  async function openProject(id) {
    setStep("processing");
    setStatus("loading project…");
    setError("");
    try {
      const p = await api.getProject(id);
      setJob(p.job_id);
      setTitle(p.title || "");
      setDuration(p.duration || 0);
      setStems(p.stems || {});
      setOriginalSpec(p.stems?.original?.spectrogram || "");
      setVocalEnvelope(p.vocal_envelope || []);
      setEnvelopeTimes(p.envelope_times || []);
      const segs = hydrateSegments(p.segments, p.stems || {});
      setSegments(segs);
      setActiveSegId(segs[0]?.id || null);
      // If hydration added missing default signals, leave lastSaved empty so the
      // autosave persists them; otherwise mark as already-saved (no redundant PUT).
      const loadedCount = (p.segments || []).reduce((a, s) => a + ((s.signals || []).length), 0);
      const mergedCount = segs.reduce((a, s) => a + s.signals.length, 0);
      lastSaved.current = mergedCount === loadedCount
        ? JSON.stringify({ step: p.step || "studio", segments: serializeSegments(segs) })
        : "";
      setStep(p.step || "studio");
    } catch (e) {
      setError(e.message);
      setStep("error");
    }
  }

  // ---- per-segment signal edits --------------------------------------------
  const editActiveSignals = useCallback((fn) => {
    setSegments((prev) =>
      prev.map((s) => (s.id === activeSegId ? { ...s, signals: fn(s.signals) } : s))
    );
  }, [activeSegId]);

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

  function validateSplit() {
    if (segments.length) setActiveSegId(segments[0].id);
    setStep("studio");
  }

  function toProjects() {
    engine.reset();
    audioEls.current.clear();
    setSegments([]);
    setActiveSegId(null);
    setPlaying(new Set());
    setAllPlaying(false);
    setJob(null);
    setError("");
    lastSaved.current = "";
    setStep("projects");
  }

  return (
    <div className={"wrap" + (step === "studio" ? " wide" : "")}>
      <header>
        <div className="brand">
          <h1>DEMUCS.STUDIO</h1>
          <span className="sub">{title || "segment · isolate · extract signals"}</span>
        </div>
        {(step === "review" || step === "studio" || step === "upload") && (
          <button className="btn" onClick={toProjects}>↩ projects</button>
        )}
      </header>

      {step === "projects" && (
        <ProjectList
          onNew={() => setStep("upload")}
          onOpen={openProject}
          onFluidLab={() => setStep("fluidlab")}
        />
      )}
      {step === "fluidlab" && <FluidLab onBack={() => setStep("projects")} />}
      {step === "upload" && <UploadStep onSubmit={handleUpload} />}
      {step === "processing" && <Processing status={status} />}
      {step === "error" && (
        <div className="error">
          Error: {error}
          <div style={{ marginTop: 12 }}>
            <button className="btn sm" onClick={toProjects}>↩ back to projects</button>
          </div>
        </div>
      )}

      {step === "review" && (
        <ReviewStep
          specUrl={originalSpec}
          audioUrl={job ? `/audio/${job}/original` : ""}
          duration={duration}
          segments={segments}
          setSegments={setSegments}
          vocalEnvelope={vocalEnvelope}
          envelopeTimes={envelopeTimes}
          onValidate={validateSplit}
          onBack={toProjects}
        />
      )}

      {step === "studio" && (
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
              preload="metadata"
              onPlay={() => setAllPlaying(true)}
              onPause={() => setAllPlaying(false)}
              onEnded={() => setAllPlaying(false)}
              onTimeUpdate={(e) => {
                if (e.target.currentTime >= winEnd) {
                  e.target.pause();
                  e.target.currentTime = winEnd;
                }
              }}
            />
            <div className="results-head">
              <span className="section-title">
                {activeSeg ? activeSeg.label.toUpperCase() : "SEGMENT"} · EXTRACT SIGNALS BY TRACK
              </span>
              <div className="controls">
                <button className="btn sm" onClick={() => setStep("review")}>↩ edit split</button>
                <button className="btn on" onClick={playAll}>
                  {allPlaying ? "❚❚ pause" : "▶ play segment"}
                </button>
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
      )}
    </div>
  );
}
