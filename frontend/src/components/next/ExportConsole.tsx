// The final export, as a job console.
//
// The whole-track export is the longest thing this app does — minutes, sometimes tens
// of them — and the screen this replaced showed a percentage that could sit still the
// entire time. Two reasons, and they compounded:
//
//   1. It destructured `useRenderJob` WITHOUT `phase` — the field the hook exists to
//      surface ("so a job doing slow work outside the frame loop doesn't look hung at
//      0%"). Regenerating HD images and muxing audio both happen with the frame counter
//      frozen. Only OutputNode ever read it.
//   2. The readiness checklist and the progress bar were two separate things, so while
//      it rendered, the list of segments — the only structure the job has — just sat
//      there greyed out.
//
// So: one list. Before you press Generate it is the readiness checklist; while it runs
// it is the progress. A segment goes pending → rendering (with its phase) → done, and
// "45s / 210s" becomes "segment 3 of 9 · CHORUS · regenerating images".

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import * as api from "../../lib/api";
import { fmtTime } from "../../lib/mel";
import { aspectOf, fitToRatio, ratioLabel } from "../../lib/output";
import { useRenderJob } from "../../lib/useRenderJob";
import { finalOutputIdOf, rootCompositionOf } from "../../lib/compositions";
import { usePreservePlayback } from "../animation/nodes/usePreservePlayback";
import TrimRow from "../export/TrimRow";
import { NumberField, SelectField, clampTo } from "../../ui/Field";
import Info from "../../ui/Info";
import type { ExportSettings } from "../../lib/export";
import type { CompositionPool, OutputSettings, Segment } from "../../lib/types";

// What the backend's `phase` means, in words that say why nothing is moving.
const PHASE_LABEL: Record<string, string> = {
  assets: "regenerating images in HD",
  // Its own phase because it is the only asset pass that can run for hours — one
  // diffusion call per frame — and the only one that drives the frame counters, so
  // "assets" sitting at 0% would be the wrong story to tell about it.
  dream: "generating Dream frames",
  render: "rendering frames",
  audio: "muxing audio",
};

export interface ExportConsoleProps {
  job?: string;
  segments: Segment[];
  compositions: CompositionPool;
  exportSettings: ExportSettings;
  setExportSettings: (o: ExportSettings) => void;
  output: OutputSettings;
  onOpenSegment?: (segId: string) => void;
}

export default function ExportConsole({
  job,
  segments,
  compositions,
  exportSettings,
  setExportSettings,
  output,
  onOpenSegment,
}: ExportConsoleProps) {
  const set = (patch: Partial<ExportSettings>) =>
    setExportSettings({ ...exportSettings, ...patch });
  // The export aspect is LOCKED to the studio canvas: the flow's fluid grid and
  // fractional-box layers are composed for that shape, so a different export aspect
  // would reframe everything.
  const canvasRatio = output.width / (output.height || 1);

  // Locked is not the same as correct: a project saved before the canvas was rotated
  // still carries the old export size, and nothing else ever rewrites it. Snap it onto
  // the canvas shape on entry and whenever the canvas orientation changes, keeping the
  // longer edge so the resolution survives the rotation.
  //
  // Guarded by a ref rather than by the dep list because the effect WRITES state it is
  // keyed near: a rounding disagreement between `fitToRatio` and the manual size
  // handlers below would otherwise re-snap a size the user just typed. At most one snap
  // per distinct ratio.
  const snappedFor = useRef<number | null>(null);
  useEffect(() => {
    if (snappedFor.current === canvasRatio) return;
    snappedFor.current = canvasRatio;
    const fitted = fitToRatio(exportSettings, canvasRatio);
    if (fitted.width !== exportSettings.width || fitted.height !== exportSettings.height) {
      set(fitted);
    }
    // `exportSettings`/`set` are deliberately omitted: this effect reacts to the CANVAS
    // changing shape, not to the export size changing. Including them would re-run it on
    // the very write it just made, and the ref guard would be the only thing stopping the
    // loop — a guard doing the dep list's job.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasRatio]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const [previewCut, setPreviewCut] = useState<string | null>(null);
  const fps = exportSettings.fps || 30;
  const storeKey = job ? `export-render:${job}` : null;
  // `phase` is the field the current screen drops.
  const { busy, error, progress, phase, segment, videoUrl, finalUrl, start, cancel } =
    useRenderJob(storeKey);
  const { reset: resetPlayback } = usePreservePlayback(videoRef, videoUrl);

  const unmarked = segments.filter((s) => !finalOutputIdOf(rootCompositionOf(s, compositions)));
  const ready = segments.length > 0 && unmarked.length === 0;

  // Which segment the backend is on, by LABEL — that is what it reports. Duplicate
  // labels (two CHORUSes) resolve to the first, which is honest: nothing in the
  // status distinguishes them.
  const activeIdx = segment ? segments.findIndex((s) => s.label === segment) : -1;

  function generate() {
    if (!job) return;
    resetPlayback();
    setPreviewCut(null);
    start(() => api.startExport(job));
  }

  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const phaseLabel = phase ? PHASE_LABEL[phase] || phase : null;
  // Built from the outside in: where in the song, then which segment, then what is
  // being done to it. Each part appears only once it is known.
  const headline = !busy
    ? null
    : [
        activeIdx >= 0 ? `segment ${activeIdx + 1} of ${segments.length}` : null,
        segment,
        phaseLabel,
      ]
        .filter(Boolean)
        .join(" · ") || "starting…";

  return (
    <div className="export">
      <div className="export-body">
        <div className="export-settings">
          <div className="export-group">
            <div className="export-group-head">FORMAT</div>

            {/* Size stays hand-built: two inputs that derive each other through the
                locked ratio is not a single-value field. */}
            <div className="out-field">
              <span className="out-label">size</span>
              <Info
                text="The master's pixel dimensions. Every segment renders at this size, so it also sets how much work the export is — doubling it roughly quadruples the render time."
                section="export"
              />
              <div className="out-size">
                <input
                  type="number"
                  className="hz-input"
                  min={16}
                  max={4096}
                  step={2}
                  value={exportSettings.width}
                  aria-label="width"
                  onChange={(e) => {
                    const w = clampTo(parseFloat(e.target.value), 16, 4096);
                    set({ width: w, height: clampTo(w / canvasRatio, 16, 4096) });
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
                  aria-label="height"
                  onChange={(e) => {
                    const h = clampTo(parseFloat(e.target.value), 16, 4096);
                    set({ width: clampTo(h * canvasRatio, 16, 4096), height: h });
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

            <NumberField
              label="fps"
              help="Frames per second of the exported video. The simulation advances per frame, so a higher fps is both smoother and proportionally slower to render."
              section="export"
              value={exportSettings.fps}
              min={1}
              max={120}
              onChange={(fps) => set({ fps })}
            />

            <SelectField
              label="audio"
              help="Which audio track is muxed into the master: the original mix, or the vocals-removed instrumental mixed from the separated stems."
              section="export"
              value={exportSettings.audioMode}
              options={[
                { value: "original", label: "original (full mix)" },
                { value: "instrumental", label: "instrumental (vocals removed)" },
              ]}
              onChange={(audioMode) => set({ audioMode })}
              hint="instrumental = the separated stems minus the vocal — for covers / karaoke"
            />
          </div>

          <div className="export-group">
            <div className="export-group-head">QUALITY</div>
            <NumberField
              label="detail / grid"
              help="How fine the fluid simulation grid is. Higher means more detail in the swirls and a slower render; it does not change the output size. A graph with no simulation ignores it and renders at native resolution."
              section="export"
              value={exportSettings.gridCells}
              min={16}
              max={1024}
              step={8}
              onChange={(gridCells) => set({ gridCells })}
              hint="higher = crisper simulation, but slower to render"
            />
            <NumberField
              label="HD image size"
              help="The resolution generated images are re-made at for the master. The editor previews use a smaller, faster size; this is what the final export bakes in."
              section="animation-output-hd"
              value={exportSettings.imageSize}
              min={256}
              max={1024}
              step={64}
              onChange={(imageSize) => set({ imageSize })}
              hint="Image-gen cards regenerate in HD at export — long edge (px), scaled to your aspect. Higher = sharper but much slower."
            />
          </div>

          {/* ONE list: the readiness checklist before, the progress during. */}
          <div className="export-checklist">
            <div className="export-checklist-head">
              {busy ? "PROGRESS" : "SEGMENTS"}
              {!busy && !ready && segments.length > 0 && (
                <span className="export-seg-note">
                  {unmarked.length} still need{unmarked.length === 1 ? "s" : ""} a final output
                </span>
              )}
            </div>
            {segments.length === 0 && <div className="export-hint">no segments to export</div>}

            {segments.map((s, i) => {
              const marked = !!finalOutputIdOf(rootCompositionOf(s, compositions));
              const state = !busy
                ? marked
                  ? "ok"
                  : "warn"
                : activeIdx < 0
                  ? "pending"
                  : i < activeIdx
                    ? "done"
                    : i === activeIdx
                      ? "running"
                      : "pending";
              const jumpable = !busy && !marked && !!onOpenSegment;
              const icon = { ok: "✓", warn: "⚠", done: "✓", running: "▸", pending: "·" }[state];
              const inner = (
                <>
                  <span className="export-seg-icon">{icon}</span>
                  <span className="export-seg-label">{s.label}</span>
                  <span className="export-seg-time">
                    {fmtTime(s.start)} – {fmtTime(s.end)}
                  </span>
                  {state === "running" && phaseLabel && (
                    <span className="export-seg-note">{phaseLabel}</span>
                  )}
                  {state === "warn" && (
                    <span className="export-seg-note">
                      no final output — {jumpable ? "click to fix" : "mark one in the editor"}
                    </span>
                  )}
                </>
              );
              const cls = `export-seg st-${state}` + (jumpable ? " jump" : "");
              return jumpable ? (
                <button
                  key={s.id}
                  type="button"
                  className={cls}
                  onClick={() => onOpenSegment(s.id)}
                >
                  {inner}
                </button>
              ) : (
                <div key={s.id} className={cls}>
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
          </div>
        </div>

        <div className="export-preview">
          <div
            className="anim-output-well export-well"
            style={{ "--out-aspect": aspectOf(exportSettings) } as CSSProperties}
          >
            {videoUrl ? (
              <video
                ref={videoRef}
                className="anim-output-video"
                src={previewCut ?? videoUrl}
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
              <div className="export-progress-label">
                <strong>{headline}</strong>
                {progress && (
                  <span className="export-hint">
                    {" "}
                    · {Math.round(progress.done / fps)}s of {Math.round(progress.total / fps)}s
                  </span>
                )}
              </div>
            </div>
          )}

          {finalUrl && (
            // Download-what-you-see: after a trim the player switches to the CUT and
            // this follows it.
            <a className="btn export-download" href={previewCut ?? finalUrl} download>
              {previewCut ? "⬇ download this cut" : "⬇ download video"}
            </a>
          )}
          {finalUrl && (
            <TrimRow
              finalUrl={finalUrl}
              videoRef={videoRef}
              onPreviewCut={setPreviewCut}
              previewingCut={!!previewCut}
            />
          )}
        </div>
      </div>
    </div>
  );
}
