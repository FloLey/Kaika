import { useMemo } from "react";
import { useResolvedCurve } from "./useResolvedCurve";
import { upstreamKey, videoSource } from "../../../lib/graphModel";
import { riseFrames } from "../../../lib/imageCount";
import type { GraphNode, MontageData, VideoData, Graph } from "../../../lib/types";
import type { NodeCtx } from "./nodeProps";

// The video CARD feeding a slot, through any FX chain (transform / colorgrade / …): its
// clip is the one that has to be long enough to fill the slot. null when the slot is fed
// by something else (a fluid, an image, a sim card) — nothing to check.
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
        // A wired speed varies per frame — assume 1 rather than guess (we'd rather miss a
        // warning than invent one).
        speed: sp?.kind === "const" ? Math.max(0.01, Number(sp.value) || 1) : 1,
      };
    }
    id = videoSource(graph, n.id, "video"); // FX cards pass a stream through
  }
  return null;
}

export interface Shortfall {
  short: number;
  avail: number;
  needed: number;
  loop: boolean;
}

// Everything the montage card derives from (graph + the trigger's resolved curve + the
// asset durations): the cut schedule, per-slot durations, and the shortfall roll-up. It
// lives in a hook so BOTH the full card and the COMPACT card read the same truth — the
// warning used to live only in the full card, so a compacted montage silently hid "your
// export will have black in it", which is how a real export shipped with a black hole.
export function useMontageShortfall(node: GraphNode, ctx: NodeCtx | undefined) {
  const d = node.data as MontageData;
  const graph = ctx?.graph;
  const rawInputs = d.inputs;
  const inputs = useMemo(() => rawInputs || [], [rawInputs]);

  // The k-th WIRED slot plays musical slot k (backend `_montage_srcs` skips unwired
  // slots) — map each row to its wired ordinal so the duration labels line up.
  const wiredOrdinal = useMemo(() => {
    let w = 0;
    return inputs.map((s) => (graph && videoSource(graph, node.id, s.id) ? w++ : null));
  }, [inputs, graph, node.id]);
  const nWired = wiredOrdinal.filter((w) => w != null).length;
  const wiredSpans = useMemo(
    () =>
      inputs
        .filter((_, i) => wiredOrdinal[i] != null)
        .map((s) => Math.max(1, Math.round(s.span || 1))),
    [inputs, wiredOrdinal]
  );

  const triggerBinding = d.ports?.trigger?.binding;
  const triggerSrc = triggerBinding?.kind === "node" ? triggerBinding.nodeId : null;
  // `fps` is the CURVE's sampling rate (echoed by /resolve) — frame→seconds must use it,
  // not the project fps (a 30fps curve read as 24fps showed every boundary 25% late).
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
  // `(duration − start) / speed` seconds of material.
  const clips = useMemo(
    () =>
      inputs.map((s) => upstreamVideoCard(graph, graph ? videoSource(graph, node.id, s.id) : null)),
    [inputs, graph, node.id]
  );
  // Durations come from the ASSET RECORD (the backend ffprobes each video on upload).
  const durations = useMemo(() => {
    const byUrl: Record<string, number> = {};
    for (const a of ctx?.assets || []) {
      if (a.duration) byUrl[a.url] = a.duration;
    }
    return byUrl;
  }, [ctx?.assets]);

  // Per row, the EARLIER row playing the same clip — or null. Two slots fed by the same
  // file replay the same footage; with the same in-point they are frame-identical, which
  // reads as the video looping instead of cutting.
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
        identical: Math.abs((clips[first]?.start || 0) - (c.start || 0)) < 0.05,
      };
    });
  }, [clips]);

  // `{ short, avail, needed, loop }` when the clip falls short of its slot, else null.
  const shortfall = (i: number, w: number | null): Shortfall | null => {
    const c = clips[i];
    const needed = slotSecs(w);
    if (!c || needed == null) return null;
    const dur = durations[c.url];
    if (!dur) return null; // unknown duration (still loading / not a decodable clip)
    const avail = Math.max(0, (dur - c.start) / c.speed);
    return avail < needed - 0.05 ? { short: needed - avail, avail, needed, loop: c.loop } : null;
  };

  // Card-level roll-up: how many slots are short, and how many SECONDS of black that costs
  // (a looping slot is short but never goes black).
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

  return {
    inputs,
    wiredOrdinal,
    nWired,
    cuts,
    fps,
    slotSecs,
    slotLabel,
    clips,
    durations,
    repeats,
    shortfall,
    shortRows,
  };
}
