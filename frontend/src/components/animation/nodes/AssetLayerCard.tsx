import { useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import NodeFrame, { Port } from "./NodeFrame";
import { ParamRow } from "./FluidParamRow";
import ArgInfo from "./ArgInfo";
import StreamPreview from "./StreamPreview";
import { aspectOf } from "../../../lib/output";
import { useAssetUpload, assetName } from "./useAssetUpload";
import { useNodeData } from "./useNodeData";
import { FITS } from "./nodeConstants";
import AssetLibrary from "../../assets/AssetLibrary";
import BoxPad, { type BoxImagePreview, type BoxVideoPreview } from "./BoxPad";
import type { NodeProps } from "./nodeProps";
import type { FluidParam, ImageData, LayerFit } from "../../../lib/types";

// The shared shell of the Image + Video layer cards — they are the same card apart
// from the asset kind: an uploaded asset (drop zone / 📚 library) placed into a
// normalized box (BoxPad) and scaled to `fit`, output as video, with a ParamRow tail
// for the modulatable ports. Both card data shapes extend ImageData, so the shell
// patches through that common shape; card-specific bits plug into the slots below.
interface AssetLayerCardProps extends NodeProps {
  kind: "image" | "video"; // NodeFrame title, ArgInfo type, and library kind in one
  accept: string; // file-input filter for the drop zone ("image/*" / "video/*")
  dropIcon: string; // placeholder glyph shown before an asset is chosen
  dropEmptyLabel: string; // drop-zone label with no asset yet
  dropBusyLabel: string; // drop-zone label while uploading/importing
  dropThumb?: boolean; // image: the uploaded still becomes the drop zone's preview
  params: FluidParam[]; // the ParamRow tail (IMAGE_PARAMS / VIDEO_PARAMS)
  // Extra ways to get an asset (video: the YouTube import row), rendered after the
  // library button. A render prop so the slot can use the shared upload state.
  extraSources?: (u: { busy: boolean; fromYoutube: (url: string) => void }) => ReactNode;
  extraStatic?: ReactNode; // extra static rows between `fit` and the box (video timing)
  videoPreview?: BoxVideoPreview; // video: live clip preview inside the BoxPad
  imagePreview?: BoxImagePreview; // image: the still, shown inside the BoxPad
}

export default function AssetLayerCard({
  node,
  selected,
  helpers,
  ctx,
  onGraphChange,
  onDetach,
  onDelete,
  kind,
  accept,
  dropIcon,
  dropEmptyLabel,
  dropBusyLabel,
  dropThumb,
  params,
  extraSources,
  extraStatic,
  videoPreview,
  imagePreview,
}: AssetLayerCardProps) {
  const d = node.data as ImageData; // VideoData extends ImageData — the shared fields
  const set = useNodeData<ImageData>(node, onGraphChange);

  const { busy, err, onFile, fromYoutube, jobId } = useAssetUpload(ctx, (url) => set({ assetUrl: url }));
  const aspect = ctx?.output ? aspectOf(ctx.output) : "1 / 1";
  const [libOpen, setLibOpen] = useState(false);

  return (
    <NodeFrame
      node={node}
      title={kind}
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
      {/* The live rendered output (image/video placed in its box) — the same block-render
          that exports. Suppressed in the settings window (its right column shows it). */}
      <StreamPreview node={node} ctx={ctx} aspect={aspect} />
      <label
        className={
          "anim-asset-drop" +
          (dropThumb ? "" : " anim-asset-drop-row") +
          " no-drag" +
          (dropThumb && d.assetUrl ? " has-asset" : "")
        }
      >
        <input type="file" accept={accept} onChange={onFile} disabled={busy} hidden />
        {dropThumb && d.assetUrl ? (
          <img className="anim-asset-thumb" src={d.assetUrl} alt="" draggable={false} />
        ) : (
          <span className="anim-asset-icon">{dropIcon}</span>
        )}
        <span className="anim-asset-label">
          {busy ? dropBusyLabel : d.assetUrl ? assetName(d.assetUrl) : dropEmptyLabel}
        </span>
      </label>
      <button className="btn sm anim-asset-libbtn no-drag" onClick={() => setLibOpen(true)}>
        📚 library
      </button>
      {extraSources?.({ busy, fromYoutube })}
      {err && <div className="anim-asset-err">{err}</div>}
      {libOpen && (
        <AssetLibrary
          jobId={jobId}
          kind={kind}
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
          <ArgInfo type={kind} k="fit" />
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
        {extraStatic}
        <div className="anim-mod-remap">
          <span className="anim-mod-remap-label">
            {kind} box <ArgInfo type={kind} k="box" />
          </span>
          <BoxPad
            box={{ x: d.box_x, y: d.box_y, w: d.box_w, h: d.box_h }}
            aspect={aspect}
            onChange={(b) => set({ box_x: b.x, box_y: b.y, box_w: b.w, box_h: b.h })}
            videoPreview={videoPreview}
            imagePreview={imagePreview}
          />
        </div>
      </div>
      {params.map((p) => (
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
