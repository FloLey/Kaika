import { useCallback, useEffect, useRef, useState } from "react";
import type { Segment } from "./lib/types";
import type { UploadResult, SegmentProposal } from "./lib/api";
import ProjectList from "./components/ProjectList";
import UploadStep from "./components/upload/UploadStep";
import ReviewStep from "./components/review/ReviewStep";
import Studio from "./components/studio/Studio";
import ExportStep from "./components/export/ExportStep";
import Processing from "./components/Processing";
import LogsPanel from "./components/LogsPanel";
import SettingsModal from "./components/SettingsModal";
import ErrorToast from "./components/ErrorToast";
import { hydrateSegments, serializeSegments } from "./lib/segments";
import { OUTPUT_DEFAULTS, withOutputDefaults } from "./lib/output";
import { EXPORT_DEFAULTS, withExportDefaults } from "./lib/export";
import { useLogPoll } from "./lib/useLogPoll";
import * as logbus from "./lib/logbus";
import * as api from "./lib/api";

export default function App() {
  // projects | upload | processing | review | studio | error
  const [step, setStep] = useState("projects");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState(false);

  const [job, setJob] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [duration, setDuration] = useState(0);
  const [originalSpec, setOriginalSpec] = useState("");
  const [stems, setStems] = useState<
    Record<string, { sr?: number; spectrogram?: string; audio?: string }>
  >({});

  const [segments, setSegments] = useState<Segment[]>([]);
  const [vocalEnvelope, setVocalEnvelope] = useState<number[]>([]);
  const [envelopeTimes, setEnvelopeTimes] = useState<number[]>([]);
  const [lyricLines, setLyricLines] = useState<unknown[]>([]);
  const [activeSegId, setActiveSegId] = useState<string | null>(null);
  // Project-wide animation output settings (size/quality/fps/background).
  const [output, setOutput] = useState(OUTPUT_DEFAULTS);
  // Final-export settings (HD size/fps/detail/background) — used by the export stage.
  const [exportSettings, setExportSettings] = useState(EXPORT_DEFAULTS);
  const lastSaved = useRef("");
  // Background-job polls outlive the call that started them. Without a signal an
  // abandoned poll (unmount, or a second upload) keeps hitting /jobs and calling
  // setState forever, so every pollJob rides this controller.
  const pollAbort = useRef<AbortController | null>(null);
  const abortPoll = useCallback(() => {
    pollAbort.current?.abort();
    pollAbort.current = null;
  }, []);
  useEffect(() => abortPoll, [abortPoll]);

  // ---- logs: panel toggle, error badge, backend polling --------------------
  const [logsOpen, setLogsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [errCount, setErrCount] = useState(0);
  useEffect(() => logbus.subscribe(() => setErrCount(logbus.errorCount())), []);
  // Poll the backend log feed always (slow) so the badge stays current; faster
  // while the drawer is open.
  useLogPoll(logsOpen ? 1500 : 8000);

  // ---- autosave (debounced, serialized) --------------------------------------
  // Every project PUT rides ONE promise chain: two overlapping saves could commit
  // out of order server-side (the DB would keep the OLDER payload while the UI
  // thinks everything saved). The chain serializes them, and a queued save that a
  // newer edit superseded is skipped instead of writing stale state.
  const saveSeq = useRef(0);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (!job || (step !== "review" && step !== "studio" && step !== "export")) return;
    const payload = { step, segments: serializeSegments(segments), output, export: exportSettings };
    const jsonStr = JSON.stringify(payload);
    if (jsonStr === lastSaved.current) return;
    const t = setTimeout(() => {
      const seq = ++saveSeq.current;
      saveChain.current = saveChain.current.then(async () => {
        if (seq !== saveSeq.current) return; // superseded — a newer payload is queued
        try {
          await api.saveProject(job, payload);
          lastSaved.current = jsonStr;
          setSaveError(false);
        } catch (e) {
          // lastSaved stays stale, so the next edit retries automatically; we
          // just flag it so the user knows the latest change isn't persisted.
          console.warn("autosave failed:", (e as Error)?.message || e);
          setSaveError(true);
        }
      });
    }, 800);
    return () => clearTimeout(t);
  }, [segments, step, job, output, exportSettings]);

  // ---- lyric line edits ------------------------------------------------------
  // Rewriting line TEXT (the wedding-lyrics flow) keeps the aligned timings. The
  // PUT must carry the full autosave payload — the backend writes segments
  // unconditionally — plus the optional lyric_lines the route persists to the
  // analysis cache. Local state updates on success so every consumer (lyrics
  // card preview, render keys) picks the new words up immediately. Joins the same
  // save chain so it can't interleave with an in-flight autosave.
  const saveLyricLines = useCallback(
    async (lines: unknown[]) => {
      if (!job) return;
      const base = { step, segments: serializeSegments(segments), output, export: exportSettings };
      const run = saveChain.current.then(async () => {
        await api.saveProject(job, { ...base, lyric_lines: lines });
        setLyricLines(lines);
        lastSaved.current = JSON.stringify(base); // autosave needn't re-PUT this state
      });
      saveChain.current = run.catch(() => {}); // keep the chain alive on failure
      return run; // the editor still sees success/failure
    },
    [job, step, segments, output, exportSettings]
  );

  // ---- playground 💾 save fixture -------------------------------------------
  // Persist the CURRENT state first (the autosave is debounced — a sub-800ms edit may
  // not even be queued yet), then capture the DB into the committed fixture. Joins the
  // save chain so it can't interleave with an in-flight autosave.
  const saveFixture = useCallback(async (): Promise<api.FixtureExport> => {
    if (!job) throw new Error("no project open");
    const payload = { step, segments: serializeSegments(segments), output, export: exportSettings };
    const run = saveChain.current.then(async () => {
      await api.saveProject(job, payload);
      lastSaved.current = JSON.stringify(payload);
      return api.exportPlaygroundFixture();
    });
    saveChain.current = run.then(
      () => {},
      () => {}
    ); // keep the chain alive either way
    return run;
  }, [job, step, segments, output, exportSettings]);

  // ---- new track: upload + propose -----------------------------------------
  async function handleUpload({
    file,
    youtubeUrl,
    ytStart,
    ytEnd,
    lyrics,
    lyricsFile,
  }: {
    file: File | null;
    youtubeUrl: string;
    ytStart: string;
    ytEnd: string;
    lyrics: string;
    lyricsFile: File | null;
  }) {
    setStep("processing");
    setError("");
    abortPoll();
    const ac = (pollAbort.current = new AbortController());
    try {
      setStatus(file ? "separating stems with demucs…" : "downloading audio from YouTube…");
      const fd = new FormData();
      if (file) fd.append("file", file);
      else if (youtubeUrl) {
        fd.append("youtube_url", youtubeUrl);
        if (ytStart) fd.append("yt_start", ytStart);
        if (ytEnd) fd.append("yt_end", ytEnd);
      }
      if (lyricsFile) fd.append("lyrics_file", lyricsFile);
      else if (lyrics && lyrics.trim()) fd.append("lyrics", lyrics);

      // Both stages run in the background now; kick them off and poll for the
      // result, feeding each phase's label into the Processing screen.
      const { job_id } = await api.uploadSong(fd);
      const data = await api.pollJob<UploadResult>(job_id, setStatus, 1000, ac.signal);

      setJob(data.job_id);
      setTitle(data.title || "");
      setDuration(data.duration || 0);
      setStems(data.stems);
      setOriginalSpec(data.stems.original?.spectrogram || "");

      await api.segmentJob(job_id);
      const segData = await api.pollJob<SegmentProposal>(job_id, setStatus, 1000, ac.signal);
      setVocalEnvelope(segData.vocal_envelope || []);
      setEnvelopeTimes(segData.envelope_times || []);
      setLyricLines(segData.lyric_lines || []);
      if (segData.duration) setDuration(segData.duration);
      lastSaved.current = "";
      setSegments(hydrateSegments(segData.segments, data.stems));
      setStep("review");
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") return; // we walked away; not an error
      setError((e as Error).message);
      setStep("error");
    }
  }

  // ---- resume an existing project ------------------------------------------
  async function openProject(id: string) {
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
      setLyricLines(p.lyric_lines || []);
      setEnvelopeTimes(p.envelope_times || []);
      const segs = hydrateSegments(p.segments, p.stems || {});
      setSegments(segs);
      setActiveSegId(segs[0]?.id || null);
      const loadedOutput = withOutputDefaults(p.output);
      setOutput(loadedOutput);
      const loadedExport = withExportDefaults(p.export);
      setExportSettings(loadedExport);
      // If hydration added missing default signals, leave lastSaved empty so the
      // autosave persists them; otherwise mark as already-saved (no redundant PUT).
      const loadedCount = (p.segments || []).reduce(
        (a: number, s: { signals?: unknown[] }) => a + (s.signals || []).length,
        0
      );
      const mergedCount = segs.reduce((a, s) => a + s.signals.length, 0);
      lastSaved.current =
        mergedCount === loadedCount
          ? JSON.stringify({
              step: p.step || "studio",
              segments: serializeSegments(segs),
              output: loadedOutput,
              export: loadedExport,
            })
          : "";
      setStep(p.step || "studio");
    } catch (e) {
      setError((e as Error).message);
      setStep("error");
    }
  }

  // The Playground: the always-present, app-managed project (one pipeline per card).
  // Built lazily on first open, then loaded into the Studio like any project.
  async function openPlayground() {
    setStep("processing");
    setStatus("preparing playground…");
    setError("");
    try {
      const { job_id } = await api.ensurePlayground();
      await openProject(job_id);
    } catch (e) {
      setError((e as Error).message);
      setStep("error");
    }
  }

  function validateSplit() {
    if (segments.length) setActiveSegId(segments[0].id);
    setStep("studio");
  }

  function toProjects() {
    abortPoll(); // leaving the flow stops any upload/segment poll still running
    setSegments([]);
    setActiveSegId(null);
    setJob(null);
    setError("");
    lastSaved.current = "";
    setStep("projects");
  }

  return (
    <div className={"wrap" + (step === "studio" || step === "export" ? " wide" : "")}>
      <header>
        <div className="brand">
          <h1>
            Kaika <span className="kanji">開花</span>
          </h1>
          <span className="sub">{title || "segment · isolate · extract signals"}</span>
        </div>
        <div className="header-actions">
          {saveError && (step === "review" || step === "studio" || step === "export") && (
            <span
              className="save-warn"
              title="The latest change hasn't been saved — it will retry on your next edit."
            >
              ⚠ save failed
            </span>
          )}
          {(step === "review" || step === "studio" || step === "upload" || step === "export") && (
            <button className="btn" onClick={toProjects}>
              ↩ projects
            </button>
          )}
          <button
            className="btn"
            onClick={() => setSettingsOpen(true)}
            title="Settings (remote inference)"
            aria-label="Settings"
          >
            ⚙
          </button>
          <button
            className="btn logs-btn"
            onClick={() => setLogsOpen((v) => !v)}
            title="Logs"
            aria-label="Logs"
          >
            logs
            {errCount > 0 && <span className="logs-badge">{errCount > 99 ? "99+" : errCount}</span>}
          </button>
          <a
            className="help-link"
            href={`/?doc=${["upload", "review", "studio", "export"].includes(step) ? step : ""}`}
            target="_blank"
            rel="noopener noreferrer"
            title="User guide"
            aria-label="User guide"
          >
            ?
          </a>
        </div>
      </header>

      {step === "projects" && (
        <ProjectList
          onNew={() => setStep("upload")}
          onOpen={openProject}
          onPlayground={openPlayground}
        />
      )}
      {step === "upload" && <UploadStep onSubmit={handleUpload} />}
      {step === "processing" && <Processing status={status} />}
      {step === "error" && (
        <div className="error">
          Error: {error}
          <div style={{ marginTop: 12 }}>
            <button className="btn sm" onClick={toProjects}>
              ↩ back to projects
            </button>
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
          activeSegId={activeSegId ?? undefined}
          setActiveSegId={setActiveSegId}
          stems={stems}
          duration={duration}
          job={job ?? undefined}
          output={output}
          setOutput={setOutput}
          lyricLines={lyricLines}
          onSaveLyricLines={saveLyricLines}
          audioMode={exportSettings.audioMode}
          onEditSplit={() => setStep("review")}
          onExport={() => setStep("export")}
          onSaveFixture={saveFixture}
        />
      )}

      {step === "export" && (
        <ExportStep
          job={job ?? undefined}
          segments={segments}
          exportSettings={exportSettings}
          setExportSettings={setExportSettings}
          output={output}
          onBack={() => setStep("studio")}
          onOpenSegment={(id) => {
            setActiveSegId(id);
            setStep("studio");
          }}
        />
      )}

      <ErrorToast onOpenLogs={() => setLogsOpen(true)} />
      <LogsPanel open={logsOpen} onClose={() => setLogsOpen(false)} />
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
