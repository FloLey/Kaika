import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties } from "react";
import * as api from "../../lib/api";
import { fmtTime } from "../../lib/mel";
import { aspectOf, fitToRatio, ratioLabel } from "../../lib/output";
import { usePreservePlayback } from "../animation/nodes/usePreservePlayback";
import type { ExportSettings } from "../../lib/export";
import type { OutputSettings, Segment } from "../../lib/types";

interface ExportStepProps {
  job?: string;
  segments: Segment[];
  exportSettings: ExportSettings;
  setExportSettings: (o: ExportSettings) => void;
  // The studio canvas (output) settings — the export aspect is locked to match this,
  // so the whole-track render keeps the exact shape the flow was composed for.
  output: OutputSettings;
  onBack: () => void;
  // Jump to a segment in the studio — the readiness checklist's ⚠ rows use it so a
  // missing ★ final output is one click from being fixed.
  onOpenSegment?: (segId: string) => void;
}

// The final-export stage: render the WHOLE track in HD by stitching each segment's
// marked "final" output. Owns the HD settings form, a per-segment readiness
// checklist (every segment must have a final output), and the progressive render —
// it starts the backend export and polls it the same way an OutputNode streams a
// single clip: the preview grows block by block while running, then swaps to the
// finished file. Cancel stops it after the current block.
export default function ExportStep({
  job,
  segments,
  exportSettings,
  setExportSettings,
  output,
  onBack,
  onOpenSegment,
}: ExportStepProps) {
  const set = (patch: Partial<ExportSettings>) => setExportSettings({ ...exportSettings, ...patch });
  const clampDim = (v: number) => Math.max(16, Math.min(4096, Math.round(v || 0)));

  // The export aspect is LOCKED to the studio canvas (output settings): the flow's
  // fluid grid + fractional-box layers are composed for that shape, so a different
  // export aspect would reframe everything. The user picks the resolution/fps; the
  // shape follows the canvas. Editing one side derives the other from this ratio.
  const canvasRatio = output.width / (output.height || 1);
  // Snap AT MOST once per ratio value (ref-guarded): the effect writes state it is
  // keyed near, so without the guard a rounding disagreement between fitToRatio and
  // the manual size handlers could re-snap a size the user just typed.
  const snappedFor = useRef<number | null>(null);
  useEffect(() => {
    if (snappedFor.current === canvasRatio) return;
    snappedFor.current = canvasRatio;
    // Snap the stored export size onto the canvas aspect on entry and whenever the
    // canvas orientation changes — keep the longer edge so the resolution survives.
    const fitted = fitToRatio(exportSettings, canvasRatio);
    if (fitted.width !== exportSettings.width || fitted.height !== exportSettings.height) {
      set(fitted);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasRatio]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoUrl, setVideoUrl] = useState(""); // growing preview while running, final file when done
  const [finalUrl, setFinalUrl] = useState(""); // the finished clip (enables the download link)
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const activeRender = useRef<string | null>(null); // render_id we're polling
  const mounted = useRef(true); // false after unmount → the poll stops touching state (never cancels)
  // Keep the playhead as the growing preview swaps <video> src (same hook the card
  // previews use). The poll loop itself stays local: this stage resumes across
  // remounts via sessionStorage and never cancels its render, unlike useStreamRender.
  const { reset: resetPlayback } = usePreservePlayback(videoRef, videoUrl);

  const fps = exportSettings.fps || 30;
  // Persist the in-flight render id so leaving and returning to this stage re-attaches to
  // the SAME backend render instead of losing it (leaving no longer cancels the render).
  const storeKey = job ? `export-render:${job}` : null;

  // Readiness: every segment needs a marked final output (⚠ otherwise). Generate is
  // disabled until they all do — the backend would 400 anyway, but flag it up front.
  const unmarked = segments.filter((s) => !s.finalOutputId);
  const ready = segments.length > 0 && unmarked.length === 0;

  // Poll a running export into the UI. Shared by generate() (fresh start) and the resume
  // effect (returning to the stage). Stops updating state once unmounted, but NEVER
  // cancels the backend render — only the explicit Cancel button does that.
  const pollRender = useCallback(
    async (renderId: string) => {
      activeRender.current = renderId;
      setBusy(true);
      setError("");
      let terminal = false;
      try {
        for (;;) {
          const st = await api.getExportStatus(renderId);
          if (!mounted.current || activeRender.current !== renderId) return; // left / superseded
          if (st.total) setProgress({ done: st.frames_done, total: st.total });
          if (st.state === "running") {
            if (st.preview_url) setVideoUrl(st.preview_url); // grows block by block
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }
          terminal = true;
          if (st.state === "done") {
            if (st.url) {
              setVideoUrl(st.url);
              setFinalUrl(st.url);
            }
          } else if (st.state === "error") {
            throw new Error(st.error || "export failed");
          }
          // "gone" (the backend forgot this render_id, e.g. after a dev-server reload)
          // ends the attempt quietly, same as a stream render — no error banner.
          break; // done | error | cancelled | gone
        }
      } catch (e) {
        terminal = true; // a failed poll (e.g. the render expired) ends this attempt
        if (mounted.current) setError((e as Error)?.message || String(e));
      } finally {
        if (terminal) {
          if (storeKey) sessionStorage.removeItem(storeKey);
          activeRender.current = null;
          if (mounted.current) {
            setBusy(false);
            setProgress(null);
          }
        }
      }
    },
    [storeKey]
  );

  // Resume an in-flight render when returning to the stage (it kept running while away).
  // If the stored render is already gone, the poll's first fetch clears it.
  useEffect(() => {
    mounted.current = true;
    const pending = storeKey ? sessionStorage.getItem(storeKey) : null;
    if (pending) pollRender(pending);
    return () => {
      mounted.current = false; // stop touching state; the backend render keeps running
    };
  }, [storeKey, pollRender]);

  // Kick off the full-track export, persist its id (so it survives leaving the stage),
  // then poll it via pollRender. The preview updates as each block lands.
  async function generate() {
    if (!job || busy) return;
    setBusy(true);
    setError("");
    setVideoUrl("");
    setFinalUrl("");
    setProgress(null);
    resetPlayback(); // a fresh export plays from the top
    let started;
    try {
      started = await api.startExport(job);
    } catch (e) {
      setError((e as Error)?.message || String(e));
      setBusy(false);
      return;
    }
    if (storeKey) sessionStorage.setItem(storeKey, started.render_id);
    pollRender(started.render_id); // manages busy/progress/preview from here
  }

  // Explicit cancel: stop the backend render and forget it. This is now the ONLY path
  // that cancels — leaving the stage keeps the render running.
  function cancel() {
    if (activeRender.current) api.cancelExport(activeRender.current);
    if (storeKey) sessionStorage.removeItem(storeKey);
    activeRender.current = null;
    setBusy(false);
    setProgress(null);
  }

  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const renderLabel = progress
    ? `rendering ${Math.round(progress.done / fps)}s / ${Math.round(progress.total / fps)}s`
    : "starting…";
  const aspect = aspectOf(exportSettings);

  return (
    <div className="export">
      <div className="export-head">
        <span className="section-title">FINAL EXPORT · RENDER THE WHOLE TRACK IN HD</span>
        <button className="btn sm" onClick={onBack}>
          ↩ studio
        </button>
      </div>

      <div className="export-body">
        <div className="export-settings">
          {/* HD render settings */}
          <div className="out-field">
            <span className="out-label">size</span>
            <div className="out-size">
              <input
                type="number"
                className="hz-input"
                min={16}
                max={4096}
                step={2}
                value={exportSettings.width}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const w = clampDim(parseFloat(e.target.value));
                  set({ width: w, height: clampDim(w / canvasRatio) });
                }}
              />
              <span className="out-x">×</span>
              <input
                type="number"
                className="hz-input"
                min={16}
                max={4096}
                step={2}
                value={exportSettings.height}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const h = clampDim(parseFloat(e.target.value));
                  set({ width: clampDim(h * canvasRatio), height: h });
                }}
              />
              <span className="out-unit">px</span>
              <span
                className="export-ratio-lock"
                title="The export keeps your canvas shape (output settings) so the animation isn't reframed — change the orientation in the editor's ⚙ output."
              >
                🔒 {ratioLabel(output)}
              </span>
            </div>
          </div>

          <div className="out-field">
            <span className="out-label">fps</span>
            <input
              type="number"
              className="hz-input"
              min={1}
              max={120}
              step={1}
              value={exportSettings.fps}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                set({ fps: Math.max(1, Math.min(120, Math.round(parseFloat(e.target.value) || 0))) })
              }
            />
          </div>

          <div className="out-field">
            <span className="out-label">detail / grid</span>
            <input
              type="number"
              className="hz-input"
              min={16}
              max={1024}
              step={8}
              value={exportSettings.gridCells}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                set({
                  gridCells: Math.max(16, Math.min(1024, Math.round(parseFloat(e.target.value) || 0))),
                })
              }
            />
            <span className="export-hint">higher = crisper simulation, but slower to render</span>
          </div>

          <div className="out-field">
            <span className="out-label">HD image size</span>
            <input
              type="number"
              className="hz-input"
              min={256}
              max={1024}
              step={64}
              value={exportSettings.imageSize}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                set({
                  imageSize: Math.max(256, Math.min(1024, Math.round(parseFloat(e.target.value) || 0))),
                })
              }
            />
            <span className="export-hint">
              Image-gen cards regenerate in HD at export — long edge (px), scaled to your
              aspect. Higher = sharper but much slower.
            </span>
          </div>

          <div className="out-field">
            <span className="out-label">audio</span>
            <select
              className="anim-select"
              value={exportSettings.audioMode}
              onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                set({ audioMode: e.target.value as ExportSettings["audioMode"] })
              }
            >
              <option value="original">original (full mix)</option>
              <option value="instrumental">instrumental (vocals removed)</option>
            </select>
            <span className="export-hint">
              instrumental = the separated stems minus the vocal — for covers / karaoke
            </span>
          </div>

          {/* per-segment readiness checklist */}
          <div className="export-checklist">
            <div className="export-checklist-head">SEGMENTS</div>
            {segments.length === 0 && (
              <div className="export-hint">no segments to export</div>
            )}
            {segments.map((s) => {
              const marked = !!s.finalOutputId;
              // An unmarked row is the ONLY thing standing between you and Generate, so
              // it doubles as the click-through to the segment that needs fixing
              // (mirrors the animation palette's ⚠ problems list).
              const jumpable = !marked && !!onOpenSegment;
              const inner = (
                <>
                  <span className="export-seg-icon">{marked ? "✓" : "⚠"}</span>
                  <span className="export-seg-label">{s.label}</span>
                  <span className="export-seg-time">
                    {fmtTime(s.start)} – {fmtTime(s.end)}
                  </span>
                  {!marked && (
                    <span className="export-seg-note">
                      no final output — {jumpable ? "click to fix" : "mark one in the editor"}
                    </span>
                  )}
                </>
              );
              const cls = "export-seg" + (marked ? " ok" : " warn") + (jumpable ? " jump" : "");
              const title = marked
                ? "a final output is marked for this segment"
                : jumpable
                  ? "Open this segment in the studio and mark a final output (★ on an output card)"
                  : "no final output — mark one in the editor (★ on an output card)";
              return jumpable ? (
                <button key={s.id} type="button" className={cls} title={title} onClick={() => onOpenSegment(s.id)}>
                  {inner}
                </button>
              ) : (
                <div key={s.id} className={cls} title={title}>
                  {inner}
                </div>
              );
            })}
          </div>

          <div className="export-actions">
            {busy ? (
              <button className="btn on" onClick={cancel}>
                ✕ cancel
              </button>
            ) : (
              <button
                className="btn on"
                onClick={generate}
                disabled={!ready || !job}
                title={
                  ready
                    ? "Render the whole track in HD"
                    : "Mark a final output on every segment first"
                }
              >
                ▸ Generate
              </button>
            )}
            {!ready && segments.length > 0 && (
              <span className="export-hint">
                {unmarked.length} segment{unmarked.length === 1 ? "" : "s"} still need a final output
              </span>
            )}
          </div>
        </div>

        {/* preview + progress */}
        <div className="export-preview">
          <div
            className="anim-output-well export-well"
            style={{ "--out-aspect": aspect } as CSSProperties}
          >
            {videoUrl ? (
              <video
                ref={videoRef}
                className="anim-output-video"
                src={videoUrl}
                muted
                playsInline
                preload="auto"
                controls={!!finalUrl}
                loop={!finalUrl}
                autoPlay
              />
            ) : (
              !busy &&
              !error && <div className="anim-output-empty">no export yet — press Generate</div>
            )}
            {error && <div className="anim-output-err">{error}</div>}
          </div>

          {busy && (
            <div className="export-progress">
              <div className="export-bar">
                <div className="export-bar-fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="export-progress-label">{renderLabel}</div>
            </div>
          )}

          {finalUrl && (
            <a className="btn export-download" href={finalUrl} download>
              ⬇ download video
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
