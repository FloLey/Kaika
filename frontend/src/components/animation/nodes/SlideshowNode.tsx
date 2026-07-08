import { useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import NodeFrame, { Port } from "./NodeFrame";
import { ParamRow } from "./FluidParamRow";
import ArgInfo from "./ArgInfo";
import Ctl from "../../../ui/Ctl";
import StreamPreview from "./StreamPreview";
import { aspectOf } from "../../../lib/output";
import { useAssetUpload, assetName } from "./useAssetUpload";
import { useNodeData } from "./useNodeData";
import { useResolvedCurve } from "./useResolvedCurve";
import { dp2, FITS } from "./nodeConstants";
import { argHelp } from "../../../lib/paramHelp";
import { SLIDESHOW_PARAMS } from "../../../lib/nodeParams";
import { upstreamKey } from "../../../lib/graphModel";
import { slideshowUrls } from "../../../lib/imageCount";
import AssetLibrary from "../../assets/AssetLibrary";
import BoxPad from "./BoxPad";
import type { NodeProps } from "./nodeProps";
import type { SlideshowData, LayerFit } from "../../../lib/types";

// The slideshow layer: an ordered set of stills that ADVANCES to the next image on
// each rising edge of the `trigger` port past the built-in hysteresis threshold
// (reuses the gate logic — feed the trigger through a gate card to control exactly
// WHEN it switches). Images come from the card's own picks (drop/upload/📚 library)
// PLUS anything wired into its `images` input (an Image gen card's generated list).
// The header area shows the live switch count for this segment.
export default function SlideshowNode({
  node,
  selected,
  helpers,
  ctx,
  onGraphChange,
  onDetach,
  onDelete,
}: NodeProps) {
  const d = node.data as SlideshowData;
  const set = useNodeData<SlideshowData>(node, onGraphChange);
  const own = d.assetUrls || [];

  // Own picks + images wired in via the `images` input (a generator's list, gate-
  // capped) — ONE shared definition with the compact preview (lib/imageCount).
  const all = slideshowUrls(ctx?.graph, node);

  const { busy, err, onFile, jobId } = useAssetUpload(ctx, (url) =>
    set({ assetUrls: [...own, url] })
  );
  const aspect = ctx?.output ? aspectOf(ctx.output) : "1 / 1";
  const [libOpen, setLibOpen] = useState(false);
  const removeAt = (i: number) => set({ assetUrls: own.filter((_, k) => k !== i) });

  // How many times the slideshow will switch this segment: the trigger source's
  // REAL resolved curve (same /resolve the Scope uses) swept through this card's
  // hysteresis thresholds — rising edges = switches. upstreamKey keys the refetch on
  // the trigger source's whole contributing subgraph (editing the wired gate/signal
  // used to leave a stale count — the old key only watched this card's own fields).
  const triggerBinding = d.ports?.trigger?.binding;
  const triggerSrc = triggerBinding?.kind === "node" ? triggerBinding.nodeId : null;
  const { curve } = useResolvedCurve(
    triggerSrc ? ctx : undefined,
    triggerSrc || "",
    triggerSrc && ctx?.graph ? upstreamKey(ctx.graph, triggerSrc, ctx?.segment?.signals) : ""
  );
  const switches = useMemo(() => {
    if (!triggerSrc || !curve.length) return 0;
    const hi = Math.min(1, d.threshold + d.hysteresis / 2);
    const lo = Math.max(0, d.threshold - d.hysteresis / 2);
    let state = 0;
    let rises = 0;
    let first = true;
    for (const v of curve) {
      if (state === 0 && v >= hi) {
        state = 1;
        if (!first) rises += 1; // frame 0 starting high isn't a switch
      } else if (state === 1 && v < lo) state = 0;
      first = false;
    }
    return rises;
  }, [curve, triggerSrc, d.threshold, d.hysteresis]);

  return (
    <NodeFrame
      node={node}
      title="slideshow"
      accent="var(--courant)"
      selected={selected}
      onTitlePointerDown={helpers.onTitlePointerDown}
      onDelete={onDelete}
      sideIn={
        <Port
          kind="in"
          flow="images"
          nodeId={node.id}
          portId="images"
          portRef={helpers.portRef}
          title="images in — wire an Image gen card's output here"
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
          title="video out"
        />
      }
    >
      {/* The live rendered output — the slides advancing on the trigger exactly as they
          export. Suppressed in the settings window (its right column shows it). */}
      <StreamPreview node={node} ctx={ctx} aspect={aspect} />
      {/* Live wiring summary: images available × how often the trigger will switch. */}
      <div className="anim-fx-hint anim-slideshow-count">
        {all.length} image{all.length === 1 ? "" : "s"}
        {all.length > own.length && ` (${all.length - own.length} generated)`} · switches{" "}
        <strong>{switches}×</strong> this segment
      </div>
      {all.length > 0 && (
        <div className="anim-imagegen-strip no-drag">
          {all.map((u, i) => (
            <span
              className={"anim-imagegen-slot" + (i >= own.length ? " gen" : "")}
              key={`${u}-${i}`}
              title={i >= own.length ? `generated · ${assetName(u)}` : assetName(u)}
            >
              <img src={u} alt="" draggable={false} />
              {i < own.length && (
                <button
                  className="anim-imagegen-remove"
                  title="remove from the slideshow"
                  onClick={() => removeAt(i)}
                >
                  ✕
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      <label className="anim-asset-drop anim-asset-drop-row no-drag">
        <input type="file" accept="image/*" onChange={onFile} disabled={busy} hidden />
        <span className="anim-asset-icon">🖼️</span>
        <span className="anim-asset-label">
          {busy ? "uploading…" : own.length ? "add another image" : "drop images here (or click)"}
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
            set({ assetUrls: [...own, a.url] });
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
          {...argHelp("slideshow", "threshold")}
        />
        <Ctl
          label="hysteresis"
          value={d.hysteresis}
          min={0}
          max={0.5}
          step={0.01}
          fmt={dp2}
          onChange={(v) => set({ hysteresis: v })}
          {...argHelp("slideshow", "hysteresis")}
        />
        <label className="anim-select-row">
          <span className="anim-select-label">fit</span>
          <ArgInfo type="slideshow" k="fit" />
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
            image box <ArgInfo type="slideshow" k="box" />
          </span>
          <BoxPad
            box={{ x: d.box_x, y: d.box_y, w: d.box_w, h: d.box_h }}
            aspect={aspect}
            onChange={(b) => set({ box_x: b.x, box_y: b.y, box_w: b.w, box_h: b.h })}
          />
        </div>
      </div>
      {SLIDESHOW_PARAMS.map((p) => (
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
