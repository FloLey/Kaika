import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import NodeFrame, { Port } from "./NodeFrame";
import NodeSettingsModal from "../NodeSettingsModal";
import { outputHash, outputRenderable } from "../../../lib/graphModel";
import { aspectOf } from "../../../lib/output";
import { usePreservePlayback } from "./usePreservePlayback";
import { useStreamRender } from "./useStreamRender";
import { useSyncedPlayback } from "./useSyncedPlayback";
import type { NodeProps } from "./nodeProps";

// The render sink (01 §3.1 output). One `in` video port; the body is the rendered
// clip. Each output node renders ITS OWN pipeline (the fluid wired into it, N per
// graph) — it owns its busy/error/url and a debounced /animate request keyed on a
// per-output subgraph hash, so editing one pipeline re-renders only its output.
// The video's frame is slaved to the SHARED segment clock (ctx.groupClock =
// Studio's refAudio) so it plays and scrubs in lock-step with the segment audio and
// the signal pulse pads. Shows not-rendered / rendering / error states.
export default function OutputNode({ node, selected, helpers, ctx, onGraphChange, onDelete }: NodeProps) {
  const {
    graph,
    segment,
    job,
    output,
    signals,
    lyricLines,
    lyricsKey,
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
  const renderKey = useMemo(
    () =>
      graph
        ? outputHash(
            graph,
            node.id,
            job as string | undefined,
            segment?.start,
            segment?.end,
            signals
          ) +
          JSON.stringify(output || {}) +
          // The backend folds a lyrics card's burned-in text into output_hash, so a
          // change to the aligned lines (which arrive async) must re-trigger the
          // render. The editor serializes them ONCE (ctx.lyricsKey) for all outputs.
          `|ly:${lyricsKey ?? JSON.stringify(lyricLines || [])}`
        : "",
    [graph, node.id, job, segment?.start, segment?.end, signals, output, lyricsKey, lyricLines]
  );

  // Auto-render this output (debounced, block-streamed, cancel-on-edit) — the same
  // machinery the fluid/combine card previews use, but OUTSIDE the preview-slot cap:
  // an output is what the user is waiting on, so it never queues behind a card.
  const { videoUrl, busy, error, progress } = useStreamRender(ctx, node.id, renderKey, renderable, {
    slot: false,
  });

  const { reset: resetPlayback } = usePreservePlayback(videoRef, videoUrl);
  // A fresh edit restarts the preview from the top.
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
        {videoUrl ? (
          <video
            ref={videoRef}
            className="anim-output-video"
            src={videoUrl}
            muted
            playsInline
            preload="auto"
            loop={!groupPlaying}
            autoPlay={!groupPlaying}
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
    </NodeFrame>
  );
}
