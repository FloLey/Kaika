import { useState } from "react";
import type { ChangeEvent } from "react";
import NodeFrame, { Port } from "./NodeFrame";
import { ParamRow } from "./FluidParamRow";
import ArgInfo from "./ArgInfo";
import Ctl from "../../../ui/Ctl";
import { aspectOf } from "../../../lib/output";
import { useAssetUpload, assetName } from "./useAssetUpload";
import { useNodeData } from "./useNodeData";
import { dp2, FITS } from "./nodeConstants";
import { argHelp } from "../../../lib/paramHelp";
import { IMAGEGEN_PARAMS } from "../../../lib/nodeParams";
import { generateImage, pollJob } from "../../../lib/api";
import AssetLibrary from "../../assets/AssetLibrary";
import BoxPad from "./BoxPad";
import type { NodeProps } from "./nodeProps";
import type { Asset, ImagegenData, LayerFit } from "../../../lib/types";

// The image-generator / slideshow layer: an ordered strip of stills that ADVANCES
// to the next image on each rising edge of the `trigger` port past the card's
// built-in hysteresis threshold (reuses the gate logic, so a hovering trigger
// can't machine-gun the slideshow). Images come from uploads, the 📚 library, or
// ✨ local generation (part B). Placed into a box like the image card; `opacity`
// and `trigger` are ports.
export default function ImagegenNode({
  node,
  selected,
  helpers,
  ctx,
  onGraphChange,
  onDetach,
  onDelete,
}: NodeProps) {
  const d = node.data as ImagegenData;
  const set = useNodeData<ImagegenData>(node, onGraphChange);
  const urls = d.assetUrls || [];

  const { busy, err, onFile, jobId } = useAssetUpload(ctx, (url) =>
    set({ assetUrls: [...urls, url] })
  );
  const aspect = ctx?.output ? aspectOf(ctx.output) : "1 / 1";
  const [libOpen, setLibOpen] = useState(false);

  const removeAt = (i: number) => set({ assetUrls: urls.filter((_, k) => k !== i) });

  // ✨ local generation: kick a background job (the GPU queue), poll it, and append
  // the new content-addressed asset URLs to the slideshow. Errors (e.g. the model
  // stack not installed) surface inline; the card stays fully usable without it.
  const [genBusy, setGenBusy] = useState(false);
  const [genErr, setGenErr] = useState<string | null>(null);
  const onGenerate = async () => {
    if (!jobId || !d.prompt.trim() || genBusy) return;
    setGenBusy(true);
    setGenErr(null);
    try {
      const { job_id } = await generateImage(jobId, d.prompt.trim(), d.seed);
      const result = await pollJob<{ assets: Asset[] }>(job_id);
      const fresh = (result.assets || []).map((a) => a.url);
      // Re-read the node's CURRENT list via the updater (urls may be stale by now),
      // then bump the seed so the next ✨ gives a new variation by default.
      set({ seed: d.seed + fresh.length });
      if (fresh.length) {
        onGraphChange((g) => ({
          ...g,
          nodes: g.nodes.map((n) =>
            n.id === node.id
              ? ({
                  ...n,
                  data: {
                    ...n.data,
                    assetUrls: [...((n.data as ImagegenData).assetUrls || []), ...fresh],
                  },
                } as typeof n)
              : n
          ),
        }));
      }
    } catch (ex) {
      setGenErr(ex instanceof Error ? ex.message : "generation failed");
    } finally {
      setGenBusy(false);
    }
  };

  return (
    <NodeFrame
      node={node}
      title="image gen"
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
      {/* The ordered slideshow: thumbnails in trigger order, ✕ to drop one. */}
      {urls.length > 0 && (
        <div className="anim-imagegen-strip no-drag">
          {urls.map((u, i) => (
            <span className="anim-imagegen-slot" key={`${u}-${i}`} title={assetName(u)}>
              <img src={u} alt="" draggable={false} />
              <button
                className="anim-imagegen-remove"
                title="remove from the slideshow"
                onClick={() => removeAt(i)}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <label className="anim-asset-drop anim-asset-drop-row no-drag">
        <input type="file" accept="image/*" onChange={onFile} disabled={busy} hidden />
        <span className="anim-asset-icon">🖼️</span>
        <span className="anim-asset-label">
          {busy ? "uploading…" : urls.length ? "add another image" : "drop images here (or click)"}
        </span>
      </label>
      <button className="btn sm anim-asset-libbtn no-drag" onClick={() => setLibOpen(true)}>
        📚 library
      </button>
      {/* ✨ local generation (Stable Diffusion on the GPU job queue). */}
      <div className="anim-imagegen-gen no-drag">
        <input
          className="anim-imagegen-prompt"
          type="text"
          placeholder="describe an image to generate…"
          value={d.prompt}
          onChange={(e: ChangeEvent<HTMLInputElement>) => set({ prompt: e.target.value })}
          {...{ title: argHelp("imagegen", "prompt").help }}
        />
        <button
          className="btn sm"
          onClick={onGenerate}
          disabled={genBusy || !d.prompt.trim()}
          title="Generate an image locally (first run downloads the model, ~2 GB)"
        >
          {genBusy ? "…" : "✨ generate"}
        </button>
      </div>
      {genErr && <div className="anim-asset-err">{genErr}</div>}
      {err && <div className="anim-asset-err">{err}</div>}
      {libOpen && (
        <AssetLibrary
          jobId={jobId}
          kind="image"
          onPick={(a) => {
            set({ assetUrls: [...urls, a.url] });
            setLibOpen(false);
          }}
          onClose={() => setLibOpen(false)}
        />
      )}
      <div className="anim-static">
        <Ctl
          label="threshold"
          value={d.threshold}
          min={0}
          max={1}
          step={0.01}
          fmt={dp2}
          onChange={(v) => set({ threshold: v })}
          {...argHelp("imagegen", "threshold")}
        />
        <Ctl
          label="hysteresis"
          value={d.hysteresis}
          min={0}
          max={0.5}
          step={0.01}
          fmt={dp2}
          onChange={(v) => set({ hysteresis: v })}
          {...argHelp("imagegen", "hysteresis")}
        />
        <label className="anim-select-row">
          <span className="anim-select-label">fit</span>
          <ArgInfo type="imagegen" k="fit" />
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
            image box <ArgInfo type="imagegen" k="box" />
          </span>
          <BoxPad
            box={{ x: d.box_x, y: d.box_y, w: d.box_w, h: d.box_h }}
            aspect={aspect}
            onChange={(b) => set({ box_x: b.x, box_y: b.y, box_w: b.w, box_h: b.h })}
          />
        </div>
      </div>
      {IMAGEGEN_PARAMS.map((p) => (
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
