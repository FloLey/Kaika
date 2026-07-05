import { useState } from "react";
import type { ChangeEvent } from "react";
import NodeFrame, { Port } from "./NodeFrame";
import { ParamRow } from "./FluidParamRow";
import ArgInfo from "./ArgInfo";
import { patchNodeData } from "../../../lib/graphModel";
import { IMAGE_PARAMS } from "../../../lib/nodeParams";
import { aspectOf } from "../../../lib/output";
import { useAssetUpload, assetName } from "./useAssetUpload";
import AssetLibrary from "../../assets/AssetLibrary";
import BoxPad from "./BoxPad";
import type { NodeProps } from "./nodeProps";
import type { ImageData, LayerFit } from "../../../lib/types";

// Image source: an uploaded still placed into a normalized box and scaled to `fit`, output
// as video (→ a stack combine or an output). The upload zone POSTs the file to
// /upload-asset/<job> (via useAssetUpload) and stores the served URL in `data.assetUrl`.
// The box + fit are static; `opacity` is the only modulatable port.
const FITS: LayerFit[] = ["cover", "contain", "stretch"];

export default function ImageNode({ node, selected, helpers, ctx, onGraphChange, onDetach, onDelete }: NodeProps) {
  const d = node.data as ImageData;
  const set = (patch: Partial<ImageData>) =>
    onGraphChange((g) => patchNodeData(g, node.id, patch as Record<string, unknown>));

  const { busy, err, onFile, jobId } = useAssetUpload(ctx, (url) => set({ assetUrl: url }));
  const aspect = ctx?.output ? aspectOf(ctx.output) : "1 / 1";
  const [libOpen, setLibOpen] = useState(false);

  return (
    <NodeFrame
      node={node}
      title="image"
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
      <label className={`anim-asset-drop no-drag${d.assetUrl ? " has-asset" : ""}`}>
        <input type="file" accept="image/*" onChange={onFile} disabled={busy} hidden />
        {d.assetUrl ? (
          <img className="anim-asset-thumb" src={d.assetUrl} alt="" draggable={false} />
        ) : (
          <span className="anim-asset-icon">🖼</span>
        )}
        <span className="anim-asset-label">
          {busy ? "uploading…" : d.assetUrl ? assetName(d.assetUrl) : "drop an image"}
        </span>
      </label>
      <button className="btn sm anim-asset-libbtn no-drag" onClick={() => setLibOpen(true)}>
        📚 library
      </button>
      {err && <div className="anim-asset-err">{err}</div>}
      {libOpen && (
        <AssetLibrary
          jobId={jobId}
          kind="image"
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
          <ArgInfo type="image" k="fit" />
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
        <div className="anim-mod-remap">
          <span className="anim-mod-remap-label">
            image box <ArgInfo type="image" k="box" />
          </span>
          <BoxPad
            box={{ x: d.box_x, y: d.box_y, w: d.box_w, h: d.box_h }}
            aspect={aspect}
            onChange={(b) => set({ box_x: b.x, box_y: b.y, box_w: b.w, box_h: b.h })}
          />
        </div>
      </div>
      {IMAGE_PARAMS.map((p) => (
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
