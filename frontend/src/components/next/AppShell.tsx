// The `?ui=next` shell: the same screens, in a frame that knows where it is.
//
// The current shell keeps the screen in a `useState` string, so browser back does
// nothing, no view is linkable, and moving between stages is three one-way buttons
// scattered across three components. Here the URL is the navigation, and a stepper
// shows the whole flow with the parts you can't enter yet explained rather than
// hidden.
//
// The screens themselves are rendered UNCHANGED. That is deliberate: this proposal
// is about the frame, and mixing a frame change with a screen change would make it
// impossible to say which one you preferred.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import ProjectList from "../ProjectList";
import UploadStep from "../upload/UploadStep";
import ReviewStep from "../review/ReviewStep";
import Studio from "../studio/Studio";
import Processing from "../Processing";
import LogsPanel from "../LogsPanel";
import SettingsModal from "../SettingsModal";
import ErrorToast from "../ErrorToast";
import ExportConsole from "./ExportConsole";
import Stepper from "./Stepper";
import type { Stage } from "./Stepper";
import TransportBar from "./TransportBar";
import { useLogPoll } from "../../lib/useLogPoll";
import { useProject } from "../../lib/useProject";
import { currentRoute, defaultTab, navigate, subscribeRoute } from "../../lib/route";
import type { Route } from "../../lib/route";
import * as transport from "../../lib/transport";
import * as logbus from "../../lib/logbus";

// The route names a stage; `processing` and `error` are transient states the project
// hook owns and no URL describes.
const stageOf = (r: Route): Stage | null => (r.name === "projects" ? null : (r.name as Stage));

export default function AppShell() {
  const p = useProject();
  const route = useSyncExternalStore(subscribeRoute, currentRoute, currentRoute);

  const [logsOpen, setLogsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [errCount, setErrCount] = useState(0);
  useEffect(() => logbus.subscribe(() => setErrCount(logbus.errorCount())), []);
  useLogPoll(logsOpen ? 1500 : 8000);

  const routeJob = "job" in route ? route.job : null;
  const busy = p.step === "processing" || p.step === "error";

  // --- URL → project ---------------------------------------------------------
  // The URL names a project we don't have open (a fresh tab, a pasted link, a Back
  // that left the project): load it. Guarded by a ref as well as by `p.job`, because
  // the load is async and the effect would otherwise re-fire before `job` lands.
  const loading = useRef<string | null>(null);
  useEffect(() => {
    if (!routeJob || routeJob === p.job || loading.current === routeJob) return;
    loading.current = routeJob;
    p.openProject(routeJob);
  }, [routeJob, p]);

  // The URL is authoritative for the stage. `processing`/`error` are the exception —
  // they describe work in flight, not a place, so they hold the screen until done.
  const stage = stageOf(route);
  useEffect(() => {
    if (busy) return;
    const want = stage ?? "projects";
    if (p.step !== want) p.setStep(want);
  }, [stage, busy, p]);

  // …and for which segment, once that segment exists.
  const routeSeg = route.name === "studio" ? route.seg : undefined;
  useEffect(() => {
    if (!routeSeg || routeSeg === p.activeSegId) return;
    if (p.segments.some((s) => s.id === routeSeg)) p.setActiveSegId(routeSeg);
  }, [routeSeg, p]);

  // --- project → URL ---------------------------------------------------------
  // One reconcile per load: a project resumes at the step the DB remembers, and the
  // URL has to catch up to it so what you are looking at is what you can link to.
  // `replace`, not push — you didn't ask to go there, so Back shouldn't return to a
  // URL that just redirects here again.
  const reconciled = useRef<string | null>(null);
  useEffect(() => {
    if (!p.job || busy) return;
    if (reconciled.current === p.job) return;
    reconciled.current = p.job;
    const step = p.step as Stage;
    // The URL already names this stage: it may also carry a segment and a tab that
    // are MORE specific than anything reconstructable from state, and overwriting
    // them here would make `…/studio/s1/graph` open on the signals tab — the link
    // would be honoured and then immediately undone.
    if (route.name === step) return;
    navigate(
      step === "studio"
        ? {
            name: "studio",
            job: p.job,
            seg: p.activeSegId ?? undefined,
            tab: defaultTab(p.job),
          }
        : { name: step, job: p.job },
      { replace: true }
    );
  }, [p.job, p.step, p.activeSegId, busy, route.name]);

  // --- the shared transport ---------------------------------------------------
  // Point it at this project's mix. Idempotent, and Studio calls the same setter,
  // so whichever mounts first wins and the other is a no-op.
  useEffect(() => {
    if (!p.job) return;
    const mix = p.exportSettings.audioMode === "instrumental" ? "instrumental" : "original";
    transport.setSource(`/audio/${p.job}/${mix}`);
  }, [p.job, p.exportSettings.audioMode]);

  // Outside the studio there is no segment to be inside, so the window is the whole
  // song. Studio narrows it to the segment while it's up. No reseek — widening the
  // window under a playing head must not jump it back to zero.
  useEffect(() => {
    if (route.name === "studio") return;
    transport.setWindow(0, p.duration || 0);
  }, [route.name, p.duration]);

  // Leaving a project clears its state; the URL follows.
  const toProjects = () => {
    transport.reset();
    reconciled.current = null;
    loading.current = null;
    p.toProjects();
    navigate({ name: "projects" });
  };

  const go = (s: Stage) => {
    if (s === "upload") return navigate({ name: "upload" });
    if (!p.job) return;
    navigate(
      s === "studio"
        ? {
            name: "studio",
            job: p.job,
            seg: p.activeSegId ?? undefined,
            tab: defaultTab(p.job),
          }
        : { name: s, job: p.job }
    );
  };

  const goSegment = (id: string, tab?: "signals" | "graph") => {
    if (!p.job) return;
    navigate({ name: "studio", job: p.job, seg: id, tab: tab ?? defaultTab(p.job) });
  };

  return (
    <div className="shell">
      <header className="shell-bar">
        <div className="shell-brand">
          <span className="shell-mark">開花</span>
          <span className="shell-name">Kaika</span>
          {p.title && <span className="shell-project">{p.title}</span>}
        </div>

        <Stepper
          current={busy ? null : stageOf(route)}
          hasProject={!!p.job}
          segments={p.segments}
          compositions={p.compositions}
          onGo={go}
        />

        <div className="shell-actions">
          {p.saveError && (
            <span
              className="save-warn"
              title="The latest change hasn't been saved — it will retry on your next edit."
            >
              ⚠ save failed
            </span>
          )}
          {p.job && (
            <button className="btn sm" onClick={toProjects}>
              ↩ projects
            </button>
          )}
          <button
            className="btn sm"
            onClick={() => setSettingsOpen(true)}
            title="Settings (remote inference)"
            aria-label="Settings"
          >
            ⚙
          </button>
          <button
            className="btn sm logs-btn"
            onClick={() => setLogsOpen((v) => !v)}
            title="Logs"
            aria-label="Logs"
          >
            logs
            {errCount > 0 && <span className="logs-badge">{errCount > 99 ? "99+" : errCount}</span>}
          </button>
          <a
            className="help-link"
            href={`/?doc=${stageOf(route) ?? ""}`}
            target="_blank"
            rel="noopener noreferrer"
            title="User guide"
            aria-label="User guide"
          >
            ?
          </a>
        </div>
      </header>

      <main className="shell-stage">
        {p.step === "processing" && <Processing status={p.status} />}
        {p.step === "error" && (
          <div className="error">
            Error: {p.error}
            <div style={{ marginTop: 12 }}>
              <button className="btn sm" onClick={toProjects}>
                ↩ back to projects
              </button>
            </div>
          </div>
        )}

        {!busy && route.name === "projects" && (
          <ProjectList
            onNew={() => navigate({ name: "upload" })}
            onOpen={(id) => navigate({ name: "studio", job: id })}
            onPlayground={p.openPlayground}
          />
        )}
        {!busy && route.name === "upload" && <UploadStep onSubmit={p.handleUpload} />}

        {!busy && route.name === "review" && (
          <ReviewStep
            specUrl={p.originalSpec}
            audioUrl={p.job ? `/audio/${p.job}/original` : ""}
            duration={p.duration}
            segments={p.segments}
            setSegments={p.setSegments}
            onSplitAt={p.splitSegmentsAt}
            vocalEnvelope={p.vocalEnvelope}
            envelopeTimes={p.envelopeTimes}
            onValidate={() => go("studio")}
            onBack={toProjects}
            shared
          />
        )}

        {!busy && route.name === "studio" && (
          <Studio
            segments={p.segments}
            setSegments={p.setSegments}
            compositions={p.compositions}
            setCompositions={p.setCompositions}
            activeSegId={p.activeSegId ?? undefined}
            // Selecting a segment is a navigation now: it lands in the URL, so Back
            // returns to the segment you were on.
            setActiveSegId={(id) => goSegment(id, route.tab)}
            stems={p.stems}
            duration={p.duration}
            job={p.job ?? undefined}
            output={p.output}
            setOutput={p.setOutput}
            exportSettings={p.exportSettings}
            assets={p.assets}
            lyricLines={p.lyricLines}
            onSaveLyricLines={p.saveLyricLines}
            audioMode={p.exportSettings.audioMode}
            // The two tabs live in the URL, so a link can open the graph directly.
            tab={route.tab === "graph" ? "animation" : "signals"}
            onTabChange={(t) =>
              p.activeSegId && goSegment(p.activeSegId, t === "animation" ? "graph" : "signals")
            }
            onEditSplit={() => go("review")}
            onExport={() => go("export")}
            onSaveFixture={p.saveFixture}
          />
        )}

        {!busy && route.name === "export" && (
          // The console, not ExportStep: same job, but the checklist and the progress
          // are one list and the backend's `phase` is on screen. `↩ studio` is gone —
          // the stepper is the way back now.
          <ExportConsole
            job={p.job ?? undefined}
            segments={p.segments}
            compositions={p.compositions}
            exportSettings={p.exportSettings}
            setExportSettings={p.setExportSettings}
            output={p.output}
            onOpenSegment={(id) => goSegment(id, "graph")}
          />
        )}
      </main>

      {/* One transport for every stage. It renders here — above the screen switch —
          and `lib/transport` owns the <audio> outside the React tree entirely, so
          moving between stages can't stop the music or lose the position. */}
      {p.job && (
        <TransportBar
          duration={p.duration}
          segments={p.segments}
          activeSegId={p.activeSegId}
          onSelectSegment={(id) => goSegment(id, route.name === "studio" ? route.tab : "signals")}
        />
      )}

      <ErrorToast onOpenLogs={() => setLogsOpen(true)} />
      <LogsPanel open={logsOpen} onClose={() => setLogsOpen(false)} />
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
