import { useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import NodeFrame, { Port } from "./NodeFrame";
import { ParamRow } from "./FluidParamRow";
import { Toggle } from "../../../ui/Ctl";
import ArgInfo from "./ArgInfo";
import { patchNodeData } from "../../../lib/graphModel";
import { argHelp } from "../../../lib/paramHelp";
import { VIDEO_PARAMS } from "../../../lib/nodeParams";
import { aspectOf } from "../../../lib/output";
import { useAssetUpload, assetName } from "./useAssetUpload";
import AssetLibrary from "../../assets/AssetLibrary";
import BoxPad, { type BoxVideoPreview } from "./BoxPad";
import type { NodeProps } from "./nodeProps";
import type { VideoData, LayerFit } from "../../../lib/types";

// Video source: an uploaded clip placed into a normalized box and scaled to `fit`, output
// as video (→ a stack combine or an output). Same upload / box / fit model as the Image
// card, plus playback timing (sync / start / loop). The clip can come from a file drop, the
// project library (📚), or a YouTube URL; the served URL is stored in `data.assetUrl`. The
// box + fit + start/sync/loop are static; `opacity` and `speed` are modulatable ports.
const FITS: LayerFit[] = ["cover", "contain", "stretch"];
const SYNCS: VideoData["sync"][] = ["song", "segment"];

export default function VideoNode({ node, selected, helpers, ctx, onGraphChange, onDetach, onDelete }: NodeProps) {
  const d = node.data as VideoData;
  const set = (patch: Partial<VideoData>) =>
    onGraphChange((g) => patchNodeData(g, node.id, patch as Record<string, unknown>));

  const { busy, err, onFile, fromYoutube, jobId } = useAssetUpload(ctx, (url) => set({ assetUrl: url }));
  const aspect = ctx?.output ? aspectOf(ctx.output) : "1 / 1";
  const [libOpen, setLibOpen] = useState(false);
  const [yt, setYt] = useState("");

  // A const speed previews at that rate; a wired (modulated) speed previews at 1× (its
  // per-frame curve isn't resolved in the card — the render is authoritative).
  const speedBinding = d.ports?.speed?.binding;
  const previewSpeed = speedBinding?.kind === "const" ? Number(speedBinding.value) : 1;
  const clock = ctx?.groupClock;
  const playing = !!ctx?.groupPlaying;
  const segStart = ctx?.segStart ?? 0;
  const videoPreview = useMemo<BoxVideoPreview | undefined>(
    () =>
      d.assetUrl
        ? {
            src: d.assetUrl, fit: d.fit, sync: d.sync, start: d.start,
            speed: previewSpeed, loop: d.loop, segStart, clock, playing,
          }
        : undefined,
    [d.assetUrl, d.fit, d.sync, d.start, previewSpeed, d.loop, segStart, clock, playing]
  );

  return (
    <NodeFrame
      node={node}
      title="video"
      accent="var(--courant)"
      selected={selected}
      onTitlePointerDown={helpers.onTitlePointerDown}
      onDelete={onDelete}
      sideOut={
        <Port
          kind="out"
          flow="video"
          nodeId={node.id}
          portId="out"
          portRef={helpers.portRef}
          startConnect={helpers.startConnect}
          title="video out"
        />
      }
    >
      {/* Compact drop/replace affordance — the live clip preview is the box below. */}
      <label className="anim-asset-drop anim-asset-drop-row no-drag">
        <input type="file" accept="video/*" onChange={onFile} disabled={busy} hidden />
        <span className="anim-asset-icon">🎞</span>
        <span className="anim-asset-label">
          {busy ? "working…" : d.assetUrl ? assetName(d.assetUrl) : "drop a video"}
        </span>
      </label>
      <button className="btn sm anim-asset-libbtn no-drag" onClick={() => setLibOpen(true)}>
        📚 library
      </button>
      <div className="asset-lib-yt no-drag">
        <input
          type="text"
          className="hz-input"
          placeholder="YouTube URL"
          value={yt}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setYt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && yt.trim()) {
              fromYoutube(yt);
              setYt("");
            }
          }}
          disabled={busy}
        />
        <button
          className="btn sm"
          disabled={busy || !yt.trim()}
          onClick={() => {
            fromYoutube(yt);
            setYt("");
          }}
        >
          import
        </button>
      </div>
      {err && <div className="anim-asset-err">{err}</div>}
      {libOpen && (
        <AssetLibrary
          jobId={jobId}
          kind="video"
          onPick={(a) => {
            set({ assetUrl: a.url });
            setLibOpen(false);
          }}
          onClose={() => setLibOpen(false)}
        />
      )}
      <div className="anim-static">
        <label className="anim-select-row">
          <span className="anim-select-label">fit</span>
          <ArgInfo type="video" k="fit" />
          <select
            className="anim-select"
            value={d.fit}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => set({ fit: e.target.value as LayerFit })}
          >
            {FITS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
        <label className="anim-select-row">
          <span className="anim-select-label">sync</span>
          <ArgInfo type="video" k="sync" />
          <select
            className="anim-select"
            value={d.sync}
            onChange={(e: ChangeEvent<HTMLSelectElement>) =>
              set({ sync: e.target.value as VideoData["sync"] })
            }
          >
            {SYNCS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
        <label className="anim-select-row">
          <span className="anim-select-label">start</span>
          <ArgInfo type="video" k="start" />
          <input
            type="number"
            className="anim-select"
            step={0.1}
            min={0}
            value={d.start}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              set({ start: parseFloat(e.target.value) || 0 })
            }
          />
        </label>
        <Toggle label="loop" value={d.loop} onChange={(v) => set({ loop: v })} {...argHelp("video", "loop")} />
        <div className="anim-mod-remap">
          <span className="anim-mod-remap-label">
            video box <ArgInfo type="video" k="box" />
          </span>
          <BoxPad
            box={{ x: d.box_x, y: d.box_y, w: d.box_w, h: d.box_h }}
            aspect={aspect}
            onChange={(b) => set({ box_x: b.x, box_y: b.y, box_w: b.w, box_h: b.h })}
            videoPreview={videoPreview}
          />
        </div>
      </div>
      {VIDEO_PARAMS.map((p) => (
        <ParamRow
          key={p.key}
          node={node}
          param={p}
          helpers={helpers}
          onGraphChange={onGraphChange}
          onDetach={(key) => onDetach?.(node.id, key)}
        />
      ))}
    </NodeFrame>
  );
}
