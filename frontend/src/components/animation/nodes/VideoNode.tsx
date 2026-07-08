import { useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import AssetLayerCard from "./AssetLayerCard";
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
// library (useAssetUpload.fromYoutube). Its own component so the draft URL state lives
// outside the shared card shell.
function YoutubeImportRow({ busy, fromYoutube }: { busy: boolean; fromYoutube: (url: string) => void }) {
  const [yt, setYt] = useState("");
  return (
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
  );
}

export default function VideoNode(props: NodeProps) {
  const { node, ctx, onGraphChange } = props;
  const d = node.data as VideoData;
  const set = useNodeData<VideoData>(node, onGraphChange);

  // The live clip preview inside the BoxPad (shared builder — identical in the settings
  // window). Memo keys on the fields it reads.
  const speedBinding = d.ports?.speed?.binding;
  const previewSpeed = speedBinding?.kind === "const" ? Number(speedBinding.value) : 1;
  const clock = ctx?.groupClock;
  const playing = !!ctx?.groupPlaying;
  const segStart = ctx?.segStart ?? 0;
  const videoPreview = useMemo(
    () => buildVideoPreview(d, ctx),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [d.assetUrl, d.fit, d.sync, d.start, previewSpeed, d.loop, segStart, clock, playing]
  );

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
          </label>
          <Toggle label="loop" value={d.loop} onChange={(v) => set({ loop: v })} {...argHelp("video", "loop")} />
        </>
      }
    />
  );
}
