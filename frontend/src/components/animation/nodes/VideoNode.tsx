import { useState } from "react";
import type { ChangeEvent } from "react";
import AssetLayerCard from "./AssetLayerCard";
import CropPad from "./CropPad";
import SlideshowItemEditor from "./SlideshowItemEditor";
import { Toggle } from "../../../ui/Ctl";
import ArgInfo from "./ArgInfo";
import { argHelp } from "../../../lib/paramHelp";
import { VIDEO_PARAMS } from "../../../lib/nodeParams";
import { useNodeData } from "./useNodeData";
import { buildVideoPreview } from "./boxPreview";
import type { NodeProps } from "./nodeProps";
import type { VideoData } from "../../../lib/types";

// Video source: an uploaded clip placed into a normalized box and scaled to `fit`, output
// as video (→ a stack combine or an output). Same upload / box / fit model as the Image
// card (the shared AssetLayerCard shell), plus playback timing (sync / start / loop). The
// clip can come from a file drop, the project library (📚), or a YouTube URL; the served
// URL is stored in `data.assetUrl`. The box + fit + start/sync/loop are static; `opacity`
// and `speed` are modulatable ports.
const SYNCS: VideoData["sync"][] = ["song", "segment"];

// The extra asset source unique to video: paste a YouTube URL and import it into the
// library (useAssetUpload.fromYoutube), optionally clipped to a start→end range (only
// that section is downloaded). Its own component so the draft state lives outside the
// shared card shell.
function YoutubeImportRow({
  busy,
  fromYoutube,
}: {
  busy: boolean;
  fromYoutube: (url: string, start?: string, end?: string) => void;
}) {
  const [yt, setYt] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const go = () => {
    fromYoutube(yt, start, end);
    setYt("");
  };
  return (
    <div className="asset-lib-yt no-drag">
      <input
        type="text"
        className="hz-input"
        placeholder="YouTube URL"
        value={yt}
        onChange={(e: ChangeEvent<HTMLInputElement>) => setYt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && yt.trim()) go();
        }}
        disabled={busy}
      />
      {yt.trim() && (
        <>
          <input
            type="text"
            className="hz-input asset-lib-yt-ts"
            placeholder="0:00"
            title="Optional start — only this section of the video is downloaded"
            value={start}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setStart(e.target.value)}
            disabled={busy}
          />
          <input
            type="text"
            className="hz-input asset-lib-yt-ts"
            placeholder="end"
            title="Optional end — only this section of the video is downloaded"
            value={end}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setEnd(e.target.value)}
            disabled={busy}
          />
        </>
      )}
      <button className="btn sm" disabled={busy || !yt.trim()} onClick={go}>
        import
      </button>
    </div>
  );
}

export default function VideoNode(props: NodeProps) {
  const { node, ctx, onGraphChange } = props;
  const d = node.data as VideoData;
  const set = useNodeData<VideoData>(node, onGraphChange);
  const [pickOpen, setPickOpen] = useState(false); // the scrubbable in-point picker

  // Built inline: BoxPad depends on the preview's FIELDS, so a fresh object per render
  // costs nothing (it used to need a hand-maintained memo to avoid restarting playback).
  const videoPreview = buildVideoPreview(d, ctx, node.id);

  return (
    <AssetLayerCard
      {...props}
      kind="video"
      accept="video/*"
      dropIcon="🎞"
      dropEmptyLabel="drop a video"
      dropBusyLabel="working…"
      params={VIDEO_PARAMS}
      videoPreview={videoPreview}
      extraSources={({ busy, fromYoutube }) => (
        <YoutubeImportRow busy={busy} fromYoutube={fromYoutube} />
      )}
      extraStatic={
        <>
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
            {d.assetUrl && (
              <button
                className="iconbtn no-drag"
                title="pick the in-point by scrubbing the clip"
                onClick={() => setPickOpen(true)}
              >
                🎞
              </button>
            )}
          </label>
          {pickOpen && d.assetUrl && (
            <SlideshowItemEditor
              url={d.assetUrl}
              start={d.start || 0}
              onCommit={(start) => set({ start })}
              onClose={() => setPickOpen(false)}
            />
          )}
          <Toggle
            label="loop"
            value={d.loop}
            onChange={(v) => set({ loop: v })}
            {...argHelp("video", "loop")}
          />
        </>
      }
      afterBox={
        d.assetUrl ? (
          <div className="anim-mod-remap">
            <span className="anim-mod-remap-label">
              crop <ArgInfo type="video" k="crop" />
            </span>
            <CropPad
              crop={{ x: d.crop_x ?? 0, y: d.crop_y ?? 0, w: d.crop_w ?? 1, h: d.crop_h ?? 1 }}
              src={d.assetUrl}
              onChange={(c) => set({ crop_x: c.x, crop_y: c.y, crop_w: c.w, crop_h: c.h })}
              // fit "cover" CROPS: lock the rect to the box's output shape so the
              // selection IS the final image (contain/stretch never trim — free crop).
              targetAspect={
                d.fit !== "contain" && d.fit !== "stretch"
                  ? ((d.box_w || 1) * (ctx?.output?.width || 1080)) /
                    Math.max(1e-6, (d.box_h || 1) * (ctx?.output?.height || 1920))
                  : undefined
              }
            />
          </div>
        ) : undefined
      }
    />
  );
}
