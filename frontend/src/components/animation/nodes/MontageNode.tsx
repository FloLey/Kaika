import { useState } from "react";
import NodeFrame, { Port } from "./NodeFrame";
import { ParamRows } from "./FluidParamRow";
import Ctl from "../../../ui/Ctl";
import ArgInfo from "./ArgInfo";
import StreamPreview from "./StreamPreview";
import AssetLibrary from "../../assets/AssetLibrary";
import { ctxAspect } from "../../../lib/output";
import { useNodeData } from "./useNodeData";
import { useMontageShortfall } from "./useMontageShortfall";
import { dp2 } from "./nodeConstants";
import { argHelp } from "../../../lib/paramHelp";
import { MONTAGE_PARAMS } from "../../../lib/nodeParams";
import { leafComposition } from "../../../lib/compositions";
import { addExtract, removeExtract, setExtractSpan } from "../../../lib/graphModel";
import { jobIdOf, type NodeProps } from "./nodeProps";
import type { Asset, MontageData } from "../../../lib/types";

// The montage card: a rhythm-driven video SWITCHER over composition EXTRACTS. Each
// extract references a child composition (the unit of reuse — a leaf is just
// video → output, created by "pick a video"); the effective cut schedule — the live
// union of the `trigger` port's rising edges and the manual breakpoints, minus the
// individually disabled gate cuts — plays extract k on interval k, its child
// re-timed so local frame 0 lands on the cut. Cuts beyond the extracts are ignored:
// the last extract holds to the window end. Wire signal → gate (divide = every Nth
// beat) → trigger for musical cuts. Each row shows how long its extract lasts, so
// trimming the child's clip to the right length is a read-off, not a guess.
export default function MontageNode({
  node,
  selected,
  helpers,
  ctx,
  onGraphChange,
  onDetach,
  onDelete,
}: NodeProps) {
  const d = node.data as MontageData;
  const set = useNodeData<MontageData>(node, onGraphChange);
  const [picking, setPicking] = useState(false);

  // Everything derived from the resolved cut schedule + the referenced compositions
  // lives in a shared hook, because the COMPACT card reads the same roll-up — the
  // black warning must not vanish when a montage is collapsed (that is how it stayed
  // invisible for a whole export).
  const { extracts, comps, cuts, extractLabel, shortfall, shortRows, repeats } =
    useMontageShortfall(node, ctx);

  // "Pick a video" = the leaf shortcut: mint a video→output composition in the pool
  // and reference it from a new extract. Two writes from one click — the reference
  // and the entry must land together, and neither updater can reach the other's
  // state (the same pattern as Studio's first-edit root creation).
  const pickVideo = (asset: Asset) => {
    const comp = leafComposition(asset);
    ctx?.updateCompositions?.((pool) => ({ ...pool, [comp.id]: comp }));
    onGraphChange((g) => addExtract(g, node.id, comp.id));
  };

  const dupRows = (() => {
    const rows = repeats
      .map((r, i) => (r ? { slot: i + 1, row: r.row, identical: r.identical } : null))
      .filter((r): r is { slot: number; row: number; identical: boolean } => r != null);
    return { n: rows.length, identical: rows.filter((r) => r.identical).length, rows };
  })();

  return (
    <NodeFrame
      node={node}
      title="montage"
      accent="var(--fx)"
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
      {/* The live switched output — the cuts landing exactly as they export. */}
      <StreamPreview node={node} ctx={ctx} aspect={ctxAspect(ctx)} />
      {/* ONE status line: extracts + cuts + the black/duplicate roll-ups. A ⚠ badge on
          one row out of 37 is missed — the roll-ups ride here so they survive on the
          compact card and in the modal too. */}
      <div className="anim-fx-hint anim-slideshow-count">
        {extracts.length} extract{extracts.length === 1 ? "" : "s"} · cuts{" "}
        <strong>{cuts ? cuts.rises : 0}×</strong>
        {shortRows.black > 0.05 && (
          <span
            className="anim-montage-short"
            title={
              `${shortRows.n} extract${shortRows.n === 1 ? "" : "s"} short of material: ` +
              `${shortRows.rows.map((r) => `extract ${r.row} (−${r.short.toFixed(1)}s)`).join(", ")}. ` +
              "A clip with loop off goes BLACK once it runs out."
            }
          >
            {" · ⚠ "}
            <strong>{shortRows.black.toFixed(1)}s black</strong>
            {shortRows.looping > 0 && ` (+${shortRows.looping} loop)`}
          </span>
        )}
        {dupRows.n > 0 && (
          <span
            className={"anim-montage-dup-roll" + (dupRows.identical > 0 ? " same" : "")}
            title={
              `${dupRows.n} extract${dupRows.n === 1 ? "" : "s"} repeat an earlier one: ` +
              `${dupRows.rows
                .map(
                  (r) =>
                    `extract ${r.slot} = extract ${r.row}${r.identical ? "" : " (different in-point)"}`
                )
                .join(", ")}. ` +
              "Two extracts of the same footage from the same in-point play frame-identical — " +
              "it reads as a loop, not a cut."
            }
          >
            {" · ⧉ "}
            <strong>
              {dupRows.n} repeat{dupRows.n === 1 ? "" : "s"}
            </strong>
          </span>
        )}
        <ArgInfo type="montage" k="extracts" />
      </div>

      <div className="anim-combine-inputs">
        {extracts.map((x, k) => {
          const comp = comps[k];
          const label = extractLabel(k);
          const span = Math.max(1, Math.round(x.span || 1));
          const sf = shortfall(k);
          // Red only when the extract actually goes BLACK: a LOOPING short clip is
          // short but never dark, so it must not read as an error.
          const goesBlack = sf != null && !sf.loop;
          return (
            <div className={"anim-combine-row" + (goesBlack ? " short" : "")} key={x.id}>
              <span className="anim-combine-slot" title={comp ? comp.name : undefined}>
                {k + 1}. {comp ? comp.name : "⚠ missing composition"}
              </span>
              <button
                className={"iconbtn anim-montage-span" + (span > 1 ? " on" : "")}
                title="cuts this extract swallows — it plays that many intervals (click: ×1 → ×2 → ×3 → ×4)"
                onClick={() =>
                  onGraphChange((g) => setExtractSpan(g, node.id, x.id, span >= 4 ? 1 : span + 1))
                }
              >
                ×{span}
              </button>
              {label && <span className="anim-montage-dur">{label}</span>}
              {sf && (
                <span
                  className="anim-montage-short"
                  title={
                    `clip too short: only ${sf.avail.toFixed(1)}s left from its in-point ` +
                    `for a ${sf.needed.toFixed(1)}s extract (${sf.short.toFixed(1)}s missing) — ` +
                    (sf.loop
                      ? "it loops back to the in-point"
                      : `it goes BLACK for the last ${sf.short.toFixed(1)}s`) +
                    ". Tick loop on the clip's video card (open the extract), turn the " +
                    "extract's ×N down, or cut more often."
                  }
                >
                  ⚠ −{sf.short.toFixed(1)}s
                </span>
              )}
              {repeats[k] && (
                <span
                  className={"anim-montage-dup" + (repeats[k]!.identical ? " same" : "")}
                  title={
                    repeats[k]!.identical
                      ? `same footage as extract ${repeats[k]!.row}, from the same in-point — ` +
                        "these two play identical frames, which looks like the video looping " +
                        "instead of cutting. Change this one's in-point or pick another clip."
                      : `same footage as extract ${repeats[k]!.row}, but from a different ` +
                        "in-point — it shows another moment. Fine if that's deliberate."
                  }
                >
                  ⧉ {repeats[k]!.row}
                </span>
              )}
              <button
                className="iconbtn anim-combine-rm"
                onClick={() => onGraphChange((g) => removeExtract(g, node.id, x.id))}
                title="remove extract (the composition stays in the pool)"
              >
                ✕
              </button>
            </div>
          );
        })}
        <button
          className="btn sm anim-combine-add"
          onClick={() => setPicking(true)}
          title="pick a clip from the project library — creates a video→output composition and adds an extract playing it"
        >
          + video
        </button>
      </div>

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
      <ParamRows
        params={MONTAGE_PARAMS}
        node={node}
        helpers={helpers}
        onGraphChange={onGraphChange}
        onDetach={onDetach}
      />
      {picking && (
        <AssetLibrary
          jobId={jobIdOf(ctx?.job)}
          kind="video"
          onPick={pickVideo}
          pickLabel={`${extracts.length} extract${extracts.length === 1 ? "" : "s"}`}
          onClose={() => setPicking(false)}
        />
      )}
    </NodeFrame>
  );
}
