import { useEffect, useRef, useState } from "react";
import ProjectList from "./components/ProjectList.jsx";
import FluidLab from "./components/FluidLab.jsx";
import UploadStep from "./components/UploadStep.jsx";
import ReviewStep from "./components/ReviewStep.jsx";
import Studio from "./components/Studio.jsx";
import Processing from "./components/Processing.jsx";
import { hydrateSegments, serializeSegments } from "./segments.js";
import * as api from "./api.js";

export default function App() {
  // projects | upload | processing | review | studio | error
  const [step, setStep] = useState("projects");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState(false);

  const [job, setJob] = useState(null);
  const [title, setTitle] = useState("");
  const [duration, setDuration] = useState(0);
  const [originalSpec, setOriginalSpec] = useState("");
  const [stems, setStems] = useState({});

  const [segments, setSegments] = useState([]);
  const [vocalEnvelope, setVocalEnvelope] = useState([]);
  const [envelopeTimes, setEnvelopeTimes] = useState([]);
  const [activeSegId, setActiveSegId] = useState(null);
  const lastSaved = useRef("");

  // ---- autosave (debounced) -------------------------------------------------
  useEffect(() => {
    if (!job || (step !== "review" && step !== "studio")) return;
    const payload = { step, segments: serializeSegments(segments) };
    const jsonStr = JSON.stringify(payload);
    if (jsonStr === lastSaved.current) return;
    const t = setTimeout(() => {
      api.saveProject(job, payload)
        .then(() => { lastSaved.current = jsonStr; setSaveError(false); })
        .catch((e) => {
          // lastSaved stays stale, so the next edit retries automatically; we
          // just flag it so the user knows the latest change isn't persisted.
          console.warn("autosave failed:", e?.message || e);
          setSaveError(true);
        });
    }, 800);
    return () => clearTimeout(t);
  }, [segments, step, job]);

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

      // Both stages run in the background now; kick them off and poll for the
      // result, feeding each phase's label into the Processing screen.
      const { job_id } = await api.uploadSong(fd);
      const data = await api.pollJob(job_id, setStatus);

      setJob(data.job_id);
      setTitle(data.title || "");
      setDuration(data.duration || 0);
      setStems(data.stems);
      setOriginalSpec(data.stems.original?.spectrogram || "");

      await api.segmentJob(job_id);
      const segData = await api.pollJob(job_id, setStatus);
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

  function validateSplit() {
    if (segments.length) setActiveSegId(segments[0].id);
    setStep("studio");
  }

  function toProjects() {
    setSegments([]);
    setActiveSegId(null);
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
        <div className="header-actions">
          {saveError && (step === "review" || step === "studio") && (
            <span className="save-warn" title="The latest change hasn't been saved — it will retry on your next edit.">
              ⚠ save failed
            </span>
          )}
          {(step === "review" || step === "studio" || step === "upload") && (
            <button className="btn" onClick={toProjects}>↩ projects</button>
          )}
          <a className="help-link"
             href={`/?doc=${step === "upload" || step === "review" || step === "studio" ? step : ""}`}
             target="_blank" rel="noopener noreferrer"
             title="User guide" aria-label="User guide">?</a>
        </div>
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
        <Studio
          segments={segments}
          setSegments={setSegments}
          activeSegId={activeSegId}
          setActiveSegId={setActiveSegId}
          stems={stems}
          duration={duration}
          job={job}
          onEditSplit={() => setStep("review")}
        />
      )}
    </div>
  );
}
