import { useMemo } from "react";
import NodeFrame, { Port } from "./NodeFrame";
import { ParamRows } from "./FluidParamRow";
import Ctl from "../../../ui/Ctl";
import ArgInfo from "./ArgInfo";
import StreamPreview from "./StreamPreview";
import { ctxAspect } from "../../../lib/output";
import { useNodeData } from "./useNodeData";
import { useMontageShortfall } from "./useMontageShortfall";
import { dp2 } from "./nodeConstants";
import { argHelp } from "../../../lib/paramHelp";
import { MONTAGE_PARAMS } from "../../../lib/nodeParams";
import { defaultCardName } from "../nodeInputs";
import {
  addMontageInput,
  fillMontageSlots,
  removeMontageInput,
  setMontageSlotSpan,
} from "../../../lib/graphModel";
import type { NodeProps } from "./nodeProps";
import type { MontageData } from "../../../lib/types";

// The montage card: a rhythm-driven video SWITCHER. N ordered slot inputs (each fed
// by a video card, optionally through FX); each rising edge of the `trigger` port
// past the built-in hysteresis threshold CUTS to the next slot, whose input is
// re-timed to start exactly at the cut — so an upstream video card's `start`
// (in-point) lands on the beat. Rises beyond the input count are ignored: the last
// input holds to the segment end. Wire signal → gate (divide = every Nth beat) →
// trigger for musical cuts. Each row shows how long its slot lasts this segment,
// so trimming the upstream clip to the right length is a read-off, not a guess.
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

  // Everything derived from the resolved cut schedule + asset durations lives in a shared
  // hook, because the COMPACT card reads the same roll-up — the black warning must not
  // vanish when a montage is collapsed (that is how it stayed invisible for a whole export).
  const { inputs, wiredOrdinal, nWired, cuts, slotLabel, shortfall, shortRows, repeats } =
    useMontageShortfall(node, ctx);

  // What `+ fill` would do, for the button's label-in-a-tooltip and its disabled state.
  // Same arithmetic as `fillMontageSlots`: the budget is one span unit per cut plus one
  // for the opening slot; unwired slots (existing + about to be created) each get a card.
  const fill = useMemo(() => {
    const spent = inputs.reduce((sum, s) => sum + Math.max(1, Math.round(s.span || 1)), 0);
    const toAdd = cuts ? Math.max(0, cuts.rises + 1 - spent) : 0;
    const n = wiredOrdinal.filter((w) => w == null).length + toAdd; // empty slots + new ones
    if (!n) {
      return { n, title: cuts ? "every slot is already wired" : "no empty slot to fill" };
    }
    const slots = toAdd ? ` (${toAdd} new slot${toAdd === 1 ? "" : "s"})` : "";
    const why = cuts
      ? ` — enough for the ${cuts.rises} cuts`
      : " — wire a trigger to size it to the cuts";
    return {
      n,
      title: `create ${n} empty video card${n === 1 ? "" : "s"}${slots} and wire them to the empty slots${why}. Drop a clip on each afterwards.`,
    };
  }, [inputs, wiredOrdinal, cuts]);

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
      {/* ONE status line: wiring + cuts + the black roll-up. The black used to sit in its
          own second hint line; folding it in here (and turning the offending ROWS red
          below) means the whole card reads as a single list. The roll-up still earns its
          place — a ⚠ badge on one row out of 37 is missed, which is how an export once
          shipped with black in it — it just no longer needs a block of its own. */}
      <div className="anim-fx-hint anim-slideshow-count">
        {nWired}/{inputs.length} input{inputs.length === 1 ? "" : "s"} · cuts{" "}
        <strong>{cuts ? cuts.rises : 0}×</strong>
        {shortRows.black > 0.05 && (
          <span
            className="anim-montage-short"
            title={
              `${shortRows.n} slot${shortRows.n === 1 ? "" : "s"} short of material: ` +
              `${shortRows.rows.map((r) => `slot ${r.row} (−${r.short.toFixed(1)}s)`).join(", ")}. ` +
              "A slot with loop off goes BLACK once its clip runs out."
            }
          >
            {" · ⚠ "}
            <strong>{shortRows.black.toFixed(1)}s black</strong>
            {shortRows.looping > 0 && ` (+${shortRows.looping} loop)`}
          </span>
        )}
        <ArgInfo type="montage" k="inputs" />
      </div>

      <div className="anim-combine-inputs">
        {inputs.map((slot, i) => {
          const label = slotLabel(wiredOrdinal[i]);
          const span = Math.max(1, Math.round(slot.span || 1));
          const sf = shortfall(i, wiredOrdinal[i]);
          // Red only when the slot actually goes BLACK: a LOOPING short slot is short but
          // never dark, so it must not read as an error.
          const goesBlack = sf != null && !sf.loop;
          return (
            <div className={"anim-combine-row" + (goesBlack ? " short" : "")} key={slot.id}>
              <Port
                kind="in"
                flow="video"
                nodeId={node.id}
                portId={slot.id}
                portRef={helpers.portRef}
                title={`slot ${i + 1}${i === 0 ? " — plays from the segment start" : " — starts once the slots before it have spent their cuts"}`}
              />
              <span className="anim-combine-slot">slot {i + 1}</span>
              <button
                className={"iconbtn anim-montage-span" + (span > 1 ? " on" : "")}
                title="cuts this slot swallows — its video plays that many gate intervals (click: ×1 → ×2 → ×3 → ×4)"
                onClick={() =>
                  onGraphChange((g) =>
                    setMontageSlotSpan(g, node.id, slot.id, span >= 4 ? 1 : span + 1)
                  )
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
                    `for a ${sf.needed.toFixed(1)}s slot (${sf.short.toFixed(1)}s missing) — ` +
                    (sf.loop
                      ? "it loops back to the in-point"
                      : `the slot goes BLACK for the last ${sf.short.toFixed(1)}s`) +
                    ". Tick loop on the video card to replay it, move the in-point earlier " +
                    "(🎞 on the card), turn the slot's ×N down, or cut more often."
                  }
                >
                  ⚠ −{sf.short.toFixed(1)}s
                </span>
              )}
              {repeats[i] && (
                <span
                  className={"anim-montage-dup" + (repeats[i]!.identical ? " same" : "")}
                  title={
                    repeats[i]!.identical
                      ? `same clip as slot ${repeats[i]!.row}, from the same in-point — these ` +
                        "two slots play identical frames, which looks like the video looping " +
                        "instead of cutting. Move this one's in-point (🎞 on the video card) " +
                        "or wire a different clip."
                      : `same clip as slot ${repeats[i]!.row}, but from a different in-point — ` +
                        "it shows another moment of the same footage. Fine if that's deliberate."
                  }
                >
                  ⧉ {repeats[i]!.row}
                </span>
              )}
              {inputs.length > 1 && (
                <button
                  className="iconbtn anim-combine-rm"
                  onClick={() => onGraphChange((g) => removeMontageInput(g, node.id, slot.id))}
                  title="remove slot"
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
        <button
          className="btn sm anim-combine-add"
          onClick={() => onGraphChange((g) => addMontageInput(g, node.id))}
        >
          + slot
        </button>
        <button
          className="btn sm anim-combine-add"
          disabled={!fill.n}
          title={fill.title}
          onClick={() =>
            onGraphChange((g) =>
              fillMontageSlots(g, node.id, {
                cuts: cuts ? cuts.rises : null,
                nameFor: defaultCardName,
              })
            )
          }
        >
          + fill
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
    </NodeFrame>
  );
}
