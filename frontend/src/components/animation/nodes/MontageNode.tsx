import { useMemo } from "react";
import NodeFrame, { Port } from "./NodeFrame";
import { ParamRows } from "./FluidParamRow";
import Ctl from "../../../ui/Ctl";
import ArgInfo from "./ArgInfo";
import StreamPreview from "./StreamPreview";
import { ctxAspect } from "../../../lib/output";
import { useNodeData } from "./useNodeData";
import { useResolvedCurve } from "./useResolvedCurve";
import { dp2 } from "./nodeConstants";
import { argHelp } from "../../../lib/paramHelp";
import { MONTAGE_PARAMS } from "../../../lib/nodeParams";
import { defaultCardName } from "../nodeInputs";
import {
  addMontageInput,
  fillMontageSlots,
  removeMontageInput,
  setMontageSlotSpan,
  upstreamKey,
  videoSource,
} from "../../../lib/graphModel";
import { riseFrames } from "../../../lib/imageCount";
import type { NodeProps } from "./nodeProps";
import type { Graph, MontageData, VideoData } from "../../../lib/types";

// The video CARD feeding a slot, through any FX chain (transform / colorgrade / …):
// its clip is the one that has to be long enough to fill the slot. null when the
// slot is fed by something else (a fluid, an image, a sim card) — nothing to check.
function upstreamVideoCard(
  graph: Graph | undefined,
  srcId: string | null
): { url: string; start: number; loop: boolean; speed: number } | null {
  let id = srcId;
  for (let hops = 0; graph && id && hops < 8; hops++) {
    const n = graph.nodes.find((x) => x.id === id);
    if (!n) return null;
    if (n.type === "video") {
      const d = n.data as VideoData;
      if (!d.assetUrl) return null;
      const sp = d.ports?.speed?.binding;
      return {
        url: d.assetUrl,
        start: d.start || 0,
        loop: d.loop !== false,
        // A wired speed varies per frame — assume 1 rather than guess (we'd rather
        // miss a warning than invent one).
        speed: sp?.kind === "const" ? Math.max(0.01, Number(sp.value) || 1) : 1,
      };
    }
    id = videoSource(graph, n.id, "video"); // FX cards pass a stream through
  }
  return null;
}

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
  const rawInputs = d.inputs;
  const inputs = useMemo(() => rawInputs || [], [rawInputs]);
  const graph = ctx?.graph;

  // The k-th WIRED slot plays musical slot k (backend `_montage_srcs` skips unwired
  // slots) — map each row to its wired ordinal so the duration labels line up.
  const wiredOrdinal = useMemo(() => {
    let w = 0;
    return inputs.map((s) => (graph && videoSource(graph, node.id, s.id) ? w++ : null));
  }, [inputs, graph, node.id]);
  const nWired = wiredOrdinal.filter((w) => w != null).length;
  // Per WIRED slot, how many cuts it swallows (its ×span) — feeds the starts math.
  const wiredSpans = useMemo(
    () =>
      inputs
        .filter((_, i) => wiredOrdinal[i] != null)
        .map((s) => Math.max(1, Math.round(s.span || 1))),
    [inputs, wiredOrdinal]
  );

  // Per-slot durations from the trigger source's REAL resolved curve (same /resolve
  // the Scope uses), swept through this card's hysteresis thresholds — mirrors the
  // backend `_montage_starts`. upstreamKey keys the refetch on the trigger's whole
  // contributing subgraph (the slideshow's stale-count lesson).
  const triggerBinding = d.ports?.trigger?.binding;
  const triggerSrc = triggerBinding?.kind === "node" ? triggerBinding.nodeId : null;
  // `fps` is the CURVE's sampling rate (echoed by /resolve) — the frame→seconds
  // conversions below must use it, not the project fps directly (a 30fps curve read
  // as 24fps frames showed every window boundary 25% late).
  const { curve, fps } = useResolvedCurve(
    triggerSrc ? ctx : undefined,
    triggerSrc || "",
    triggerSrc && graph ? upstreamKey(graph, triggerSrc, ctx?.segment?.signals) : ""
  );
  const cuts = useMemo(() => {
    if (!triggerSrc || !curve.length) return null;
    const rises = riseFrames(curve, d.threshold, d.hysteresis);
    // Mirror of backend `_montage_starts`: slot k swallows wiredSpans[k] cuts; a slot
    // whose starting cut never arrives doesn't play (the previous one holds).
    const starts = [0];
    let consumed = 0;
    for (const span of wiredSpans.slice(0, -1)) {
      consumed += span;
      if (consumed - 1 >= rises.length) break;
      starts.push(rises[consumed - 1]);
    }
    return { rises: rises.length, starts, total: curve.length };
  }, [curve, triggerSrc, d.threshold, d.hysteresis, wiredSpans]);
  // How many seconds each PLAYED slot lasts (null when not computable).
  const slotSecs = (w: number | null): number | null => {
    if (w == null || !cuts || w >= cuts.starts.length) return null;
    const end = w + 1 < cuts.starts.length ? cuts.starts[w + 1] : cuts.total;
    return (end - cuts.starts[w]) / fps;
  };

  // The window label for the row holding wired ordinal `w` (null = not computable):
  // segment-local start–end seconds, so each row reads as a timeline slice.
  const slotLabel = (w: number | null): string | null => {
    if (w == null) return "unwired";
    if (!cuts) return null;
    if (w >= cuts.starts.length) return "unused"; // fewer cuts than inputs
    const end = w + 1 < cuts.starts.length ? cuts.starts[w + 1] : cuts.total;
    const t = (f: number) => (f / fps).toFixed(1);
    return `${t(cuts.starts[w])} – ${t(end)}s`;
  };

  // Per-row upstream clip (through any FX chain) + its duration, so a slot whose clip
  // can't fill it is flagged: from its in-point, at its speed, a clip yields
  // `(duration − start) / speed` seconds of material. Short of that the render loops
  // the clip (loop on) or freezes its last frame (loop off) — either way you want to
  // know, and by how much.
  const clips = useMemo(
    () =>
      inputs.map((s) => upstreamVideoCard(graph, graph ? videoSource(graph, node.id, s.id) : null)),
    [inputs, graph, node.id]
  );
  // Durations come from the ASSET RECORD (the backend ffprobes each video on upload).
  // They used to be measured in the browser by opening every clip — a gigabyte per card,
  // the very stall this preview path exists to avoid.
  const durations = useMemo(() => {
    const byUrl: Record<string, number> = {};
    for (const a of ctx?.assets || []) {
      if (a.duration) byUrl[a.url] = a.duration;
    }
    return byUrl;
  }, [ctx?.assets]);

  // Per row, the EARLIER row playing the same clip — or null. Two slots fed by the
  // same file replay the same footage; with the same in-point they are frame-identical,
  // which on screen looks exactly like the video looping instead of cutting. Nothing
  // else catches it: the shortfall warning only ever watched length, so this played
  // wrong and silently (reported as "the first video loops but nothing tells me").
  const repeats = useMemo(() => {
    const firstRow = new Map<string, number>();
    return clips.map((c, i) => {
      if (!c?.url) return null;
      const first = firstRow.get(c.url);
      if (first === undefined) {
        firstRow.set(c.url, i);
        return null;
      }
      return {
        row: first + 1,
        // Same in-point = the very same frames; a different one still repeats the clip
        // but shows another moment of it, which is often deliberate.
        identical: Math.abs((clips[first]?.start || 0) - (c.start || 0)) < 0.05,
      };
    });
  }, [clips]);

  // `{ short: seconds missing, avail, needed }` when the clip falls short, else null.
  const shortfall = (i: number, w: number | null) => {
    const c = clips[i];
    const needed = slotSecs(w);
    if (!c || needed == null) return null;
    const dur = durations[c.url];
    if (!dur) return null; // unknown duration (still loading / not a decodable clip)
    const avail = Math.max(0, (dur - c.start) / c.speed);
    return avail < needed - 0.05 ? { short: needed - avail, avail, needed, loop: c.loop } : null;
  };

  // Card-level roll-up of the per-row shortfalls: how many slots are short, and how many
  // SECONDS of black that actually costs (a looping slot is short but never goes black).
  const shortRows = useMemo(() => {
    const rows: { row: number; short: number }[] = [];
    let black = 0;
    let looping = 0;
    inputs.forEach((_s, i) => {
      const sf = shortfall(i, wiredOrdinal[i]);
      if (!sf) return;
      rows.push({ row: i + 1, short: sf.short });
      if (sf.loop) looping++;
      else black += sf.short;
    });
    return { n: rows.length, rows, black, looping };
    // `shortfall` closes over clips/durations/cuts; those are the real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs, wiredOrdinal, clips, durations, cuts, fps]);

  // What `+ fill` would do, for the button's label-in-a-tooltip and its disabled state.
  // Same arithmetic as `fillMontageSlots`: the budget is one span unit per cut plus one
  // for the opening slot; unwired slots (existing + about to be created) each get a card.
  const fill = useMemo(() => {
    const spent = inputs.reduce((sum, s) => sum + Math.max(1, Math.round(s.span || 1)), 0);
    const toAdd = cuts ? Math.max(0, cuts.rises + 1 - spent) : 0;
    const n = inputs.filter((s) => !(graph && videoSource(graph, node.id, s.id))).length + toAdd;
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
  }, [inputs, cuts, graph, node.id]);

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
      {/* Live wiring summary: inputs available × how many cuts the trigger makes. */}
      <div className="anim-fx-hint anim-slideshow-count">
        {nWired}/{inputs.length} input{inputs.length === 1 ? "" : "s"} · cuts{" "}
        <strong>{cuts ? cuts.rises : 0}×</strong> this segment
        <ArgInfo type="montage" k="inputs" />
      </div>
      {/* A ⚠ badge on ONE row out of 37 is not a warning anyone finds — a real export went
          out with 1.2s of black in it and the row badge was sitting there the whole time.
          Total the deficit here, where the eye already is. */}
      {shortRows.n > 0 && (
        <div
          className="anim-fx-hint anim-montage-short"
          title={
            `${shortRows.n} slot${shortRows.n === 1 ? "" : "s"} short of material: ` +
            `${shortRows.rows.map((r) => `slot ${r.row} (−${r.short.toFixed(1)}s)`).join(", ")}. ` +
            "A slot with loop off goes BLACK once its clip runs out."
          }
        >
          ⚠ {shortRows.n} slot{shortRows.n === 1 ? "" : "s"} short —{" "}
          <strong>{shortRows.black.toFixed(1)}s black</strong>
          {shortRows.looping > 0 && ` (+${shortRows.looping} looping)`}
        </div>
      )}

      <div className="anim-combine-inputs">
        {inputs.map((slot, i) => {
          const label = slotLabel(wiredOrdinal[i]);
          const span = Math.max(1, Math.round(slot.span || 1));
          return (
            <div className="anim-combine-row" key={slot.id}>
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
              {(() => {
                const s = shortfall(i, wiredOrdinal[i]);
                if (!s) return null;
                return (
                  <span
                    className="anim-montage-short"
                    title={
                      `clip too short: only ${s.avail.toFixed(1)}s left from its in-point ` +
                      `for a ${s.needed.toFixed(1)}s slot (${s.short.toFixed(1)}s missing) — ` +
                      (s.loop
                        ? "it loops back to the in-point"
                        : `the slot goes BLACK for the last ${s.short.toFixed(1)}s`) +
                      ". Tick loop on the video card to replay it, move the in-point earlier " +
                      "(🎞 on the card), turn the slot's ×N down, or cut more often."
                    }
                  >
                    ⚠ −{s.short.toFixed(1)}s
                  </span>
                );
              })()}
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
