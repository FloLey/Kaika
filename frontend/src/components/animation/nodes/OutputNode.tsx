import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import NodeFrame, { Port } from "./NodeFrame";
import NodeSettingsModal from "../NodeSettingsModal";
import HdViewerModal from "../HdViewerModal";
import Info from "../../../ui/Info";
import * as api from "../../../lib/api";
import { outputRenderable } from "../../../lib/graphModel";
import { aspectOf } from "../../../lib/output";
import { useRenderJob } from "../../../lib/useRenderJob";
import { usePreservePlayback } from "./usePreservePlayback";
import { forgetRender, useStreamRender } from "./useStreamRender";
import { useSyncedPlayback } from "./useSyncedPlayback";
import { jobIdOf, type NodeProps } from "./nodeProps";
import { useRenderKey } from "./useRenderKey";

// The render sink (01 §3.1 output). One `in` video port; the body is the rendered
// clip. Each output node renders ITS OWN pipeline (the fluid wired into it, N per
// graph) — it owns its busy/error/url and a debounced /animate request keyed on a
// per-output subgraph hash, so editing one pipeline re-renders only its output.
// The video's frame is slaved to the SHARED segment clock (ctx.groupClock =
// Studio's refAudio) so it plays and scrubs in lock-step with the segment audio and
// the signal pulse pads. Shows not-rendered / rendering / error states.
export default function OutputNode({
  node,
  selected,
  helpers,
  ctx,
  onGraphChange,
  onDelete,
}: NodeProps) {
  const {
    graph,
    segment,
    job,
    output,
    exportSettings,
    lyricLines,
    groupClock,
    groupPlaying,
    segStart = 0,
    finalOutputId,
    setFinalOutput,
  } = ctx || {};
  const videoRef = useRef<HTMLVideoElement>(null);

  const fps = (output as { fps?: number } | undefined)?.fps || 24;

  // The preview well adopts the project output aspect so portrait/landscape is
  // visible while editing (the rendered clip matches this exact shape).
  const aspect = output ? aspectOf(output) : "1 / 1";

  // Render key: this output's subgraph + the project render settings. Changes only
  // when THIS output's rendered clip would (see graphModel.outputHash).
  // Memoized: outputRenderable walks the whole contributing DAG; don't redo it on
  // every unrelated re-render (playhead ticks, sibling-node edits).
  const renderable = useMemo(
    () => (graph ? outputRenderable(graph, node.id) : false),
    [graph, node.id]
  );
  const renderKey = useRenderKey(ctx, node.id);

  // Auto-render this output (debounced, block-streamed, cancel-on-edit) — the same
  // machinery the fluid/combine card previews use, but in its OWN lane: an output is
  // what the user is waiting on, so it never queues behind a card preview.
  const { videoUrl, busy, error, progress } = useStreamRender(ctx, node.id, renderKey, renderable, {
    lane: "output",
  });

  // Restore-on-reload only while the transport is stopped: when it's playing,
  // useSyncedPlayback owns currentTime (it has the real clock) and a second writer
  // would race its drift correction.
  const { reset: resetPlayback } = usePreservePlayback(videoRef, videoUrl, !groupPlaying);
  // A fresh edit restarts the preview from the top. StreamPreview deliberately does
  // NOT do this, and the difference is the point: an output is the one clip the user is
  // watching, so a new render should play from the start — whereas restarting every card
  // preview on the canvas on every edit would make the whole editor twitch. Both share
  // `useRenderKey`, so they agree on WHEN a render is stale; they differ only on what to
  // do about the playhead.
  useEffect(() => {
    resetPlayback();
  }, [renderKey, resetPlayback]);
  useSyncedPlayback(videoRef, videoUrl, groupPlaying, groupClock, segStart);

  // "rendering 15s / 55s" while blocks stream in; a bare spinner label before the
  // first frame count arrives.
  const renderLabel = progress
    ? `rendering ${Math.round(progress.done / fps)}s / ${Math.round(progress.total / fps)}s`
    : "rendering…";

  // Whether THIS output is the segment's marked "final" render (what the export
  // stage stitches). Toggling passes "" to clear the mark.
  const isFinal = finalOutputId === node.id;

  // Click the render to open the settings window (big preview + ★ mark final) — output
  // never compacts, so this is its way into the modal.
  const [settingsOpen, setSettingsOpen] = useState(false);

  // ── HD render of THIS segment ─────────────────────────────────────────────
  // The card's clip is a draft (the project's quality preset) at thumbnail size.
  // "HD" renders the same pipeline at the FINAL EXPORT's settings — same size,
  // fps, detail and audio the master will use — and opens it full screen. It's a
  // long job, so it uses the export's render-job contract: it survives navigating
  // away and is only stopped by an explicit cancel.
  const jobId = jobIdOf(job);
  const hdKey = jobId && segment?.id ? `hd-render:${jobId}:${segment.id}:${node.id}` : null;
  const hd = useRenderJob(hdKey);
  const [hdOpen, setHdOpen] = useState(false);
  const hdSpecs = exportSettings
    ? `${exportSettings.width}×${exportSettings.height} · ${exportSettings.fps} fps · detail ${exportSettings.gridCells}`
    : "the final export's settings";

  // ONE body for both the render and the cache lookup: the backend hashes what we
  // send, so a lookup built even slightly differently would ask about another render.
  // The graph travels in it because autosave is debounced — the saved copy can lag
  // what's on screen, and HD must render exactly what's visible.
  const hdBody = useCallback(() => {
    if (!jobId || !graph || !segment) return null;
    return {
      job_id: jobId,
      segment: {
        id: segment.id,
        start: segment.start,
        end: segment.end,
        signals: segment.signals,
        finalOutputId,
        lyric_lines: lyricLines,
      },
      graph,
      output_id: node.id,
    };
  }, [jobId, graph, segment, finalOutputId, lyricLines, node.id]);

  function startHd() {
    const body = hdBody();
    if (!body) return;
    setHdOpen(false);
    setCachedHd("");
    hd.start(() => api.startSegmentHdRender(body));
  }

  // Already rendered? Ask once per render-relevant change, keyed on the SAME
  // `renderKey` the draft preview uses — moving a card or renaming it asks nothing;
  // only an edit that would produce different frames does. A reload lands here and
  // offers the file on disk instead of launching a render the machine already did.
  const [cachedHd, setCachedHd] = useState("");
  useEffect(() => {
    const body = hdBody();
    if (!body || hd.busy || hd.finalUrl) return;
    let live = true;
    api
      .findSegmentHdRender(body)
      .then((r) => live && setCachedHd(r.url || ""))
      .catch(() => live && setCachedHd("")); // a miss is not an error worth showing
    return () => {
      live = false;
    };
    // `renderKey` (already computed above for the draft preview) is exactly "what
    // would change the frames" — reusing it means one definition of that, and hdBody's
    // identity churn on every keystroke doesn't re-ask.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderKey, hd.busy, hd.finalUrl]);

  // Open the viewer by itself once the render lands (the whole point is to look at it).
  const hdFinal = hd.finalUrl;
  useEffect(() => {
    if (hdFinal) setHdOpen(true);
  }, [hdFinal]);

  const hdLabel = hd.busy
    ? hd.phase === "assets"
      ? "HD · preparing assets…"
      : hd.phase === "audio"
        ? "HD · adding audio…"
        : hd.progress
          ? `HD · ${Math.round((hd.progress.done / Math.max(1, hd.progress.total)) * 100)}%`
          : "HD · starting…"
    : "⬛ HD";

  return (
    <NodeFrame
      node={node}
      title="output"
      accent="var(--text)"
      selected={selected}
      onTitlePointerDown={helpers.onTitlePointerDown}
      onDelete={onDelete}
      sideIn={
        <Port
          kind="in"
          flow="video"
          nodeId={node.id}
          portId="video"
          portRef={helpers.portRef}
          title="video in"
        />
      }
      sideOut={
        <Port
          kind="out"
          flow="video"
          nodeId={node.id}
          portId="out"
          portRef={helpers.portRef}
          startConnect={helpers.startConnect}
          title="pass video through"
        />
      }
    >
      {/* Mark this output as the segment's FINAL render — the one the export stage
          stitches into the full-track clip. One per segment; toggling clears it. */}
      {setFinalOutput && (
        <button
          className={"anim-final-btn" + (isFinal ? " on" : "")}
          onClick={() => setFinalOutput(isFinal ? "" : node.id)}
          title={
            isFinal
              ? "This output is the segment's final (exported) render — click to unmark"
              : "Mark this output as the segment's final (exported) render"
          }
        >
          {isFinal ? "★ final" : "☆ mark final"}
        </button>
      )}
      {/* Render THIS segment at the final export's quality and watch it full screen. */}
      <div className="anim-hd-row">
        <button
          className={"anim-hd-btn" + (hd.busy ? " busy" : "")}
          disabled={!renderable || !jobId}
          onClick={hd.busy ? hd.cancel : startHd}
          title={
            hd.busy
              ? "cancel the HD render"
              : `Render this segment at ${hdSpecs} and watch it full screen`
          }
        >
          {hd.busy ? `${hdLabel} · cancel` : hdLabel}
        </button>
        <Info
          text={`Renders this segment at the FINAL EXPORT's settings (${hdSpecs}), with the segment's audio, and opens it full screen — what the master will actually look like.`}
          section="animation-output-hd"
        />
        {(hd.finalUrl || cachedHd) && !hd.busy && (
          <button
            className="anim-hd-view"
            onClick={() => setHdOpen(true)}
            title={
              hd.finalUrl
                ? "open the HD render"
                : "this segment is already rendered in HD — open it (no re-render)"
            }
          >
            {hd.finalUrl ? "⤢ view HD" : "⤢ view HD ✓"}
          </button>
        )}
      </div>
      {hd.error && <div className="anim-output-err">{hd.error}</div>}
      <div
        className="anim-output-well anim-output-well-open"
        style={{ "--out-aspect": aspect } as CSSProperties}
        role="button"
        title="open — big preview & mark final"
        onClick={() => setSettingsOpen(true)}
      >
        <span className="anim-output-open-badge" aria-hidden="true">
          ⤢
        </span>
        {/* `loop`/`autoPlay` are UNCONDITIONAL. They used to be !groupPlaying, so during
            playback the clip reached its end, fired `ended` and STUCK on the last frame
            while the audio looped back. Native looping wraps frame-accurate with no
            seek — and useSyncedPlayback's wrap-aware drift maths assumes it. */}
        {videoUrl ? (
          <video
            ref={videoRef}
            className="anim-output-video"
            src={videoUrl}
            muted
            playsInline
            preload="auto"
            loop
            autoPlay
            onError={() => forgetRender(videoUrl)}
          />
        ) : (
          !busy &&
          !error && (
            <div className="anim-output-empty">
              {renderable ? "not rendered yet" : "wire a fluid into this output"}
            </div>
          )
        )}
        {busy && !videoUrl && (
          <div className="anim-output-busy">
            <div className="anim-loader" aria-hidden="true">
              <span className="anim-loader-orb" />
              <span className="anim-loader-orb" />
              <span className="anim-loader-orb" />
            </div>
            <div className="anim-loader-label">{renderLabel}</div>
          </div>
        )}
        {busy && videoUrl && <div className="anim-output-progress">{renderLabel}</div>}
        {error && <div className="anim-output-err">{error}</div>}
      </div>
      {settingsOpen && onGraphChange && ctx && (
        <NodeSettingsModal
          node={node}
          ctx={ctx}
          onGraphChange={onGraphChange}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {hdOpen && (hd.finalUrl || hd.videoUrl || cachedHd) && (
        <HdViewerModal
          url={hd.finalUrl || hd.videoUrl || cachedHd}
          settings={exportSettings}
          streaming={!hd.finalUrl && !cachedHd}
          onClose={() => setHdOpen(false)}
        />
      )}
    </NodeFrame>
  );
}
