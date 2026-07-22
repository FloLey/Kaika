import { useState } from "react";
import StreamPreview from "./nodes/StreamPreview";
import InputPicker from "./InputPicker";
import AssetLibrary from "../assets/AssetLibrary";
import Ctl from "../../ui/Ctl";
import ArgInfo from "./nodes/ArgInfo";
import { useMontageShortfall } from "./nodes/useMontageShortfall";
import { useNodeData } from "./nodes/useNodeData";
import { dp2 } from "./nodes/nodeConstants";
import { argHelp } from "../../lib/paramHelp";
import { ctxAspect } from "../../lib/output";
import { videoThumbSrc } from "../../lib/assetPreview";
import { leafComposition } from "../../lib/compositions";
import {
  addExtract,
  moveExtract,
  removeExtract,
  setExtractComposition,
  setExtractSpan,
} from "../../lib/graphModel";
import { jobIdOf, type NodeCtx } from "./nodes/nodeProps";
import type { Asset, Graph, GraphNode, MontageData } from "../../lib/types";

interface Props {
  node: GraphNode; // the live montage node (updates on every graph commit)
  ctx: NodeCtx;
  onGraphChange: (updater: (g: Graph) => Graph) => void;
}

// The MONTAGE EDITOR — the full-area view a montage opens into (its own breadcrumb
// level: segment ▸ montage). The strip of extracts runs across the top, each tile
// showing its child composition (a leaf clip's thumbnail, or an "animation" tile);
// the live switched output plays large underneath, slaved to the shared transport —
// scrub the timeline and the extract under the playhead is what you see, with the
// audio it will play under. The right rail keeps the wiring surface (trigger/opacity
// via the INPUTS panel) and the gate's threshold/hysteresis.
export default function MontageEditor({ node, ctx, onGraphChange }: Props) {
  const d = node.data as MontageData;
  const set = useNodeData<MontageData>(node, onGraphChange);
  const { extracts, comps, cuts, fps, extractLabel, clips, shortfall, shortRows, repeats } =
    useMontageShortfall(node, ctx);

  // "+ video" appends a leaf; "pick" on a tile RE-POINTS that extract at a new leaf
  // (the composition it left stays in the pool — lifecycle is the prune's job).
  const [picking, setPicking] = useState<null | { replaceId?: string }>(null);
  const pickVideo = (asset: Asset) => {
    const comp = leafComposition(asset);
    ctx.updateCompositions?.((pool) => ({ ...pool, [comp.id]: comp }));
    const replaceId = picking?.replaceId;
    onGraphChange((g) =>
      replaceId
        ? setExtractComposition(g, node.id, replaceId, comp.id)
        : addExtract(g, node.id, comp.id)
    );
    if (replaceId) setPicking(null); // replacing is one pick; adding stays open for a run
  };

  const openExtract = (k: number) => {
    if (!ctx.enterExtract || !ctx.segment) return;
    const seg = ctx.segment;
    let start = seg.start;
    let end = seg.end;
    if (cuts && k < cuts.starts.length) {
      const endF = k + 1 < cuts.starts.length ? cuts.starts[k + 1] : cuts.total;
      start = seg.start + cuts.starts[k] / fps;
      end = seg.start + endF / fps;
    }
    ctx.enterExtract(node.id, extracts[k].id, { start, end });
  };

  // Strip drag-reorder: plain HTML5 drag, dropping on a tile moves the dragged
  // extract to that index (moveExtract clamps).
  const [dragFrom, setDragFrom] = useState<number | null>(null);

  return (
    <div className="montage-editor">
      <div className="montage-strip" role="list" aria-label="extracts">
        {extracts.map((x, k) => {
          const comp = comps[k];
          const clip = clips[k];
          const sf = shortfall(k);
          const goesBlack = sf != null && !sf.loop;
          const label = extractLabel(k);
          return (
            <div
              key={x.id}
              role="listitem"
              className={
                "montage-tile" + (goesBlack ? " short" : "") + (label === "unused" ? " unused" : "")
              }
              draggable
              onDragStart={() => setDragFrom(k)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragFrom != null && dragFrom !== k) {
                  onGraphChange((g) => moveExtract(g, node.id, extracts[dragFrom].id, k));
                }
                setDragFrom(null);
              }}
            >
              <div className="montage-tile-thumb">
                {clip ? (
                  <img src={videoThumbSrc(clip.url)} alt="" draggable={false} />
                ) : (
                  <span className="montage-tile-anim">{comp ? "✦" : "⚠"}</span>
                )}
              </div>
              <div className="montage-tile-name" title={comp?.name}>
                {k + 1}. {comp ? comp.name : "missing composition"}
              </div>
              <div className="montage-tile-meta">
                {label && <span className="anim-montage-dur">{label}</span>}
                {sf && (
                  <span
                    className="anim-montage-short"
                    title={
                      `clip too short: ${sf.avail.toFixed(1)}s available for a ` +
                      `${sf.needed.toFixed(1)}s extract — ` +
                      (sf.loop ? "it loops" : `BLACK for the last ${sf.short.toFixed(1)}s`)
                    }
                  >
                    ⚠ −{sf.short.toFixed(1)}s
                  </span>
                )}
                {repeats[k] && (
                  <span
                    className={"anim-montage-dup" + (repeats[k]!.identical ? " same" : "")}
                    title={`same footage as extract ${repeats[k]!.row}${
                      repeats[k]!.identical ? " — identical frames" : " (different in-point)"
                    }`}
                  >
                    ⧉ {repeats[k]!.row}
                  </span>
                )}
              </div>
              <div className="montage-tile-actions">
                <button
                  className={"iconbtn anim-montage-span" + ((x.span || 1) > 1 ? " on" : "")}
                  title="cuts this extract swallows (click: ×1 → ×2 → ×3 → ×4)"
                  onClick={() =>
                    onGraphChange((g) =>
                      setExtractSpan(
                        g,
                        node.id,
                        x.id,
                        Math.max(1, Math.round(x.span || 1)) >= 4
                          ? 1
                          : Math.max(1, Math.round(x.span || 1)) + 1
                      )
                    )
                  }
                >
                  ×{Math.max(1, Math.round(x.span || 1))}
                </button>
                <button
                  className="iconbtn"
                  title="pick a different clip for this extract"
                  onClick={() => setPicking({ replaceId: x.id })}
                >
                  🎬
                </button>
                {comp && (
                  <button
                    className="iconbtn anim-extract-open"
                    title="open this extract's composition — edit what it plays"
                    onClick={() => openExtract(k)}
                  >
                    ▸
                  </button>
                )}
                <button
                  className="iconbtn anim-combine-rm"
                  title="remove extract (the composition stays in the pool)"
                  onClick={() => onGraphChange((g) => removeExtract(g, node.id, x.id))}
                >
                  ✕
                </button>
              </div>
            </div>
          );
        })}
        <button
          className="montage-tile montage-tile-add"
          onClick={() => setPicking({})}
          title="pick a clip from the library — it becomes a video→output composition played by a new extract"
        >
          + video
        </button>
      </div>

      <div className="montage-editor-body">
        <div className="montage-live">
          {/* The switched output, big, slaved to the shared transport — at any
              playhead position this IS the current extract, playing under its audio. */}
          <StreamPreview node={node} ctx={ctx} aspect={ctxAspect(ctx)} />
          <div className="anim-fx-hint anim-slideshow-count">
            {extracts.length} extract{extracts.length === 1 ? "" : "s"} · cuts{" "}
            <strong>{cuts ? cuts.rises : 0}×</strong>
            {shortRows.black > 0.05 && (
              <span className="anim-montage-short">
                {" · ⚠ "}
                <strong>{shortRows.black.toFixed(1)}s black</strong>
              </span>
            )}
            <ArgInfo type="montage" k="extracts" />
          </div>
        </div>

        <div className="montage-rail">
          <div className="anim-static">
            <Ctl
              label="threshold"
              value={d.threshold}
              min={0}
              max={1}
              step={0.01}
              fmt={dp2}
              onChange={(v) => set({ threshold: v })}
              {...argHelp("montage", "threshold")}
            />
            <Ctl
              label="hysteresis"
              value={d.hysteresis}
              min={0}
              max={0.5}
              step={0.01}
              fmt={dp2}
              onChange={(v) => set({ hysteresis: v })}
              {...argHelp("montage", "hysteresis")}
            />
          </div>
          {/* The wiring surface (trigger/opacity: value + source), same panel as the
              settings window — the editor replaces the modal for this card. */}
          {ctx.graph && (
            <InputPicker
              node={node}
              graph={ctx.graph}
              signals={ctx.segment?.signals}
              onGraphChange={onGraphChange}
            />
          )}
        </div>
      </div>

      {picking && (
        <AssetLibrary
          jobId={jobIdOf(ctx.job)}
          kind="video"
          onPick={pickVideo}
          pickLabel={
            picking.replaceId
              ? "pick the replacement"
              : `${extracts.length} extract${extracts.length === 1 ? "" : "s"}`
          }
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  );
}
