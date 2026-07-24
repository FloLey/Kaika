import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties } from "react";
import * as api from "../../lib/api";
import { fmtTime } from "../../lib/mel";
import { aspectOf, fitToRatio, ratioLabel } from "../../lib/output";
import { useRenderJob } from "../../lib/useRenderJob";
import { finalOutputIdOf, rootCompositionOf } from "../../lib/compositions";
import { usePreservePlayback } from "../animation/nodes/usePreservePlayback";
import TrimRow from "./TrimRow";
import type { ExportSettings } from "../../lib/export";
import type { CompositionPool, OutputSettings, Segment } from "../../lib/types";
import Info from "../../ui/Info";

interface ExportStepProps {
  job?: string;
  segments: Segment[];
  // The composition pool — where each segment's ★-final mark lives now
  // (composition.outputId), so readiness resolves through it.
  compositions: CompositionPool;
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
  compositions,
  exportSettings,
  setExportSettings,
  output,
  onBack,
  onOpenSegment,
}: ExportStepProps) {
  const set = (patch: Partial<ExportSettings>) =>
    setExportSettings({ ...exportSettings, ...patch });
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
  // The trim row can point the stage player at the FINISHED CUT (then back) — the
  // player is where "what will the result be" gets answered, not a second player.
  const [previewCut, setPreviewCut] = useState<string | null>(null);
  const fps = exportSettings.fps || 30;
  // Persist the in-flight render id so leaving and returning to this stage re-attaches to
  // the SAME backend render instead of losing it (leaving no longer cancels the render).
  const storeKey = job ? `export-render:${job}` : null;
  // Poll/persist/resume/cancel — shared with the Output card's HD render, which
  // follows the same long-lived-job contract (never cancels on unmount).
  const { busy, error, progress, segment, videoUrl, finalUrl, start, cancel } =
    useRenderJob(storeKey);
  // Keep the playhead as the growing preview swaps <video> src (same hook the card
  // previews use).
  const { reset: resetPlayback } = usePreservePlayback(videoRef, videoUrl);

  // Readiness: every segment needs a marked final output (⚠ otherwise). Generate is
  // disabled until they all do — the backend would 400 anyway, but flag it up front.
  // Resolves like the backend does: the composition's explicit mark, else its sole
  // output card.
  const unmarked = segments.filter((s) => !finalOutputIdOf(rootCompositionOf(s, compositions)));
  const ready = segments.length > 0 && unmarked.length === 0;

  // Kick off the full-track export, persist its id (so it survives leaving the stage),
  // then poll it via pollRender. The preview updates as each block lands.
  async function generate() {
    if (!job) return;
    resetPlayback(); // a fresh export plays from the top
    setPreviewCut(null);
    start(() => api.startExport(job));
  }

  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  // The frame counter only moves once a segment finishes — a long song sits on the same
  // number for minutes, which reads as "stuck". Naming the segment being worked on is
  // what makes the wait legible; the bar itself still jumps.
  const segLabel = segment ? ` · segment ${segment}` : "";
  const renderLabel = progress
    ? `rendering ${Math.round(progress.done / fps)}s / ${Math.round(progress.total / fps)}s${segLabel}`
    : segment
      ? `rendering segment ${segment}`
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
          {/* FORMAT — what the finished file IS: its dimensions, its frame rate, its
              audio track. These interleaved with the quality knobs before, so
              "detail / grid" (which does not change the output size at all) sat
              between fps and the image resolution. */}
          <div className="export-group">
            <div className="export-group-head">FORMAT</div>
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
              <Info
                text="Frames per second of the exported video. The simulation advances per frame, so a higher fps is both smoother and proportionally slower to render."
                section="export"
              />
              <input
                type="number"
                className="hz-input"
                min={1}
                max={120}
                step={1}
                value={exportSettings.fps}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  set({
                    fps: Math.max(1, Math.min(120, Math.round(parseFloat(e.target.value) || 0))),
                  })
                }
              />
            </div>

            <div className="out-field">
              <span className="out-label">audio</span>
              <Info
                text="Which audio track is muxed into the master: the original mix, or the vocals-removed instrumental mixed from the separated stems."
                section="export"
              />
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
          </div>

          {/* QUALITY — how much work goes INTO each frame. Neither of these changes the
              file's dimensions; both trade render time for detail, which is exactly the
              thing you want to weigh in one place. */}
          <div className="export-group">
            <div className="export-group-head">QUALITY</div>

            <div className="out-field">
              <span className="out-label">detail / grid</span>
              <Info
                text="How fine the fluid simulation grid is. Higher means more detail in the swirls and a slower render; it does not change the output size. A graph with no simulation ignores it and renders at native resolution."
                section="export"
              />
              <input
                type="number"
                className="hz-input"
                min={16}
                max={1024}
                step={8}
                value={exportSettings.gridCells}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  set({
                    gridCells: Math.max(
                      16,
                      Math.min(1024, Math.round(parseFloat(e.target.value) || 0))
                    ),
                  })
                }
              />
              <span className="export-hint">higher = crisper simulation, but slower to render</span>
            </div>

            <div className="out-field">
              <span className="out-label">HD image size</span>
              <Info
                text="The resolution generated images are re-made at for the master. The editor previews use a smaller, faster size; this is what the final export bakes in."
                section="animation-output-hd"
              />
              <input
                type="number"
                className="hz-input"
                min={256}
                max={1024}
                step={64}
                value={exportSettings.imageSize}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  set({
                    imageSize: Math.max(
                      256,
                      Math.min(1024, Math.round(parseFloat(e.target.value) || 0))
                    ),
                  })
                }
              />
              <span className="export-hint">
                Image-gen cards regenerate in HD at export — long edge (px), scaled to your aspect.
                Higher = sharper but much slower.
              </span>
            </div>
          </div>

          {/* per-segment readiness checklist */}
          <div className="export-checklist">
            <div className="export-checklist-head">SEGMENTS</div>
            {segments.length === 0 && <div className="export-hint">no segments to export</div>}
            {segments.map((s) => {
              const marked = !!finalOutputIdOf(rootCompositionOf(s, compositions));
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
                <button
                  key={s.id}
                  type="button"
                  className={cls}
                  title={title}
                  onClick={() => onOpenSegment(s.id)}
                >
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
                {unmarked.length} segment{unmarked.length === 1 ? "" : "s"} still need a final
                output
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
              <div className="export-progress-label">{renderLabel}</div>
            </div>
          )}

          {finalUrl && (
            // Download-what-you-see: after a trim the player switches to the CUT,
            // and this button follows it — clicking the big obvious button after
            // cutting used to hand back the whole master.
            <a className="btn export-download" href={previewCut ?? finalUrl} download>
              {previewCut ? "⬇ download this cut" : "⬇ download video"}
            </a>
          )}
          {/* Platform-length cuts out of the finished master (Insta caps a reel at
              ~3 min) — the master itself stays whole. */}
          {finalUrl && (
            <TrimRow
              finalUrl={finalUrl}
              videoRef={videoRef}
              onPreviewCut={setPreviewCut}
              previewingCut={previewCut != null}
            />
          )}
        </div>
      </div>
    </div>
  );
}
