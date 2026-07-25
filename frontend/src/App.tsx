import { useEffect, useState } from "react";
import ProjectList from "./components/ProjectList";
import UploadStep from "./components/upload/UploadStep";
import ReviewStep from "./components/review/ReviewStep";
import Studio from "./components/studio/Studio";
import ExportStep from "./components/export/ExportStep";
import Processing from "./components/Processing";
import LogsPanel from "./components/LogsPanel";
import SettingsModal from "./components/SettingsModal";
import ErrorToast from "./components/ErrorToast";
import { useLogPoll } from "./lib/useLogPoll";
import { useProject } from "./lib/useProject";
import * as logbus from "./lib/logbus";

// The current shell: a step string chooses which screen renders, and the header
// carries the global chrome. The PROJECT — nineteen pieces of state, the autosave,
// the montage-drift reconciler and the three save paths — lives in `useProject`, so
// this file owns only what is genuinely its own: the logs drawer, the settings modal
// and the layout.
export default function App() {
  const {
    step,
    status,
    error,
    saveError,
    job,
    title,
    duration,
    originalSpec,
    assets,
    stems,
    segments,
    compositions,
    vocalEnvelope,
    envelopeTimes,
    lyricLines,
    activeSegId,
    output,
    exportSettings,
    setStep,
    setSegments,
    setCompositions,
    setActiveSegId,
    setOutput,
    setExportSettings,
    handleUpload,
    openProject,
    openPlayground,
    validateSplit,
    splitSegmentsAt,
    toProjects,
    saveLyricLines,
    saveFixture,
  } = useProject();

  // ---- logs: panel toggle, error badge, backend polling --------------------
  const [logsOpen, setLogsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [errCount, setErrCount] = useState(0);
  useEffect(() => logbus.subscribe(() => setErrCount(logbus.errorCount())), []);
  // Poll the backend log feed always (slow) so the badge stays current; faster
  // while the drawer is open.
  useLogPoll(logsOpen ? 1500 : 8000);

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
          onSplitAt={splitSegmentsAt}
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
          compositions={compositions}
          setCompositions={setCompositions}
          activeSegId={activeSegId ?? undefined}
          setActiveSegId={setActiveSegId}
          stems={stems}
          duration={duration}
          job={job ?? undefined}
          output={output}
          setOutput={setOutput}
          exportSettings={exportSettings}
          assets={assets}
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
          compositions={compositions}
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
