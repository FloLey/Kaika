import { useMemo } from "react";
import { useResolvedCurve } from "./useResolvedCurve";
import { isLooseEdge, upstreamKey, videoSource } from "../../../lib/graphModel";
import { riseFrames } from "../../../lib/imageCount";
import { cutMarks, effectiveCuts, partStarts } from "../../../lib/cutSchedule";
import type { CombineData, Graph, GraphNode, MontageData, VideoData } from "../../../lib/types";
import type { NodeCtx } from "./nodeProps";

// The video CARD inside a child composition whose clip bounds the extract: a leaf,
// a leaf through FX cards, or a leaf inside a COMBINE (a "video + caption" child —
// slots are walked in slot order and the first branch that reaches a video card
// wins; text/backdrop/fluid branches resolve to nothing and are skipped). null when
// no video feeds the output at all — nothing to thumbnail or duration-check.
export function leafVideoCard(graph: Graph | undefined): {
  url: string;
  start: number;
  loop: boolean;
  speed: number;
  nodeId: string; // the video card itself — the montage editor's crop pad edits it
  crop: { x: number; y: number; w: number; h: number };
} | null {
  if (!graph) return null;
  const out = graph.nodes.find((n) => n.type === "output");
  const walk = (id: string | null | undefined, hops: number): ReturnType<typeof leafVideoCard> => {
    if (!id || hops > 8) return null;
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
        nodeId: n.id,
        crop: { x: d.crop_x ?? 0, y: d.crop_y ?? 0, w: d.crop_w ?? 1, h: d.crop_h ?? 1 },
      };
    }
    if (n.type === "combine") {
      const slots = (n.data as CombineData).inputs.map((s) => s.id);
      const rank = (p: string) => {
        const i = slots.indexOf(p);
        return i < 0 ? slots.length : i;
      };
      const feeds = (graph.edges || [])
        .filter((e) => e.target === n.id && !isLooseEdge(e))
        .sort((a, b) => rank(a.targetPort) - rank(b.targetPort));
      for (const e of feeds) {
        const hit = walk(e.source, hops + 1);
        if (hit) return hit;
      }
      return null;
    }
    return walk(videoSource(graph, n.id, "video"), hops + 1); // FX cards pass a stream through
  };
  return walk(out ? videoSource(graph, out.id, "video") : null, 0);
}

export interface Shortfall {
  short: number;
  avail: number;
  needed: number;
  loop: boolean;
}

// Everything the montage card derives from (the extracts + the trigger's resolved
// curve + manual breakpoints + the referenced compositions + asset durations): the
// effective cut schedule, per-extract windows, and the shortfall/duplicate roll-ups.
// It lives in a hook so BOTH the full card and the COMPACT card read the same truth —
// the warning used to live only in the full card, so a compacted montage silently hid
// "your export will have black in it", which is how a real export shipped with a
// black hole.
export function useMontageShortfall(node: GraphNode, ctx: NodeCtx | undefined) {
  const d = node.data as MontageData;
  const graph = ctx?.graph;
  const pool = ctx?.compositions;
  const rawExtracts = d.extracts;
  const extracts = useMemo(() => rawExtracts || [], [rawExtracts]);
  const spans = useMemo(
    () => extracts.map((x) => Math.max(1, Math.round(x.span || 1))),
    [extracts]
  );

  const triggerBinding = d.ports?.trigger?.binding;
  const triggerSrc = triggerBinding?.kind === "node" ? triggerBinding.nodeId : null;
  // `fps` is the CURVE's sampling rate (echoed by /resolve) — frame→seconds must use it,
  // not the project fps (a 30fps curve read as 24fps showed every boundary 25% late).
  const { curve, fps: curveFps } = useResolvedCurve(
    triggerSrc ? ctx : undefined,
    triggerSrc || "",
    triggerSrc && graph ? upstreamKey(graph, triggerSrc, ctx?.segment?.signals) : ""
  );

  // The cut schedule works WITHOUT a trigger too (manual breakpoints alone) — the
  // gate is one of two live sources now, not a prerequisite. Without a curve the
  // timeline falls back to the project fps for the seconds↔frames mapping.
  const manualJson = JSON.stringify(d.manualBreakpoints || []);
  const disabledJson = JSON.stringify(d.disabledCuts || []);
  const cuts = useMemo(() => {
    const haveCurve = !!triggerSrc && curve.length > 0;
    const fps = haveCurve ? curveFps : ctx?.output?.fps || 24;
    const segLen = Math.max(0.001, (ctx?.segment?.end ?? 0) - (ctx?.segment?.start ?? 0) || 0.001);
    const total = haveCurve ? curve.length : Math.max(1, Math.round(segLen * fps));
    if (!haveCurve && !(d.manualBreakpoints || []).length) return null;
    const gateRises = haveCurve ? riseFrames(curve, d.threshold, d.hysteresis) : [];
    const frames = effectiveCuts(gateRises, d, fps, total);
    return {
      frames,
      rises: frames.length,
      starts: partStarts(frames, spans),
      // Every mark with its provenance (gate/manual, disabled) — the timeline's rows.
      marks: cutMarks(gateRises, d, fps, total),
      total,
      fps,
    };
    // manual/disabled ride as JSON so an in-place data edit still recomputes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    curve,
    curveFps,
    triggerSrc,
    d.threshold,
    d.hysteresis,
    manualJson,
    disabledJson,
    spans,
    ctx?.output?.fps,
    ctx?.segment?.start,
    ctx?.segment?.end,
  ]);
  const fps = cuts?.fps ?? (ctx?.output?.fps || 24);

  // How many seconds extract k lasts (null when not computable).
  const extractSecs = (k: number): number | null => {
    if (!cuts || k >= cuts.starts.length) return null;
    const end = k + 1 < cuts.starts.length ? cuts.starts[k + 1] : cuts.total;
    return (end - cuts.starts[k]) / fps;
  };

  // The window label for extract k: window-local start–end seconds, so each row
  // reads as a timeline slice. "unused" = fewer cuts than extracts (it never plays).
  const extractLabel = (k: number): string | null => {
    if (!cuts) return null;
    if (k >= cuts.starts.length) return "unused";
    const end = k + 1 < cuts.starts.length ? cuts.starts[k + 1] : cuts.total;
    const t = (f: number) => (f / fps).toFixed(1);
    return `${t(cuts.starts[k])} – ${t(end)}s`;
  };

  // Per extract: its child composition and, when that child is a LEAF, the video
  // clip whose length bounds the extract.
  const comps = useMemo(
    () => extracts.map((x) => (pool ? pool[x.compositionId] : undefined) || null),
    [extracts, pool]
  );
  const clips = useMemo(() => comps.map((c) => leafVideoCard(c?.graph)), [comps]);
  // Durations come from the ASSET RECORD (the backend ffprobes each video on upload).
  const durations = useMemo(() => {
    const byUrl: Record<string, number> = {};
    for (const a of ctx?.assets || []) {
      if (a.duration) byUrl[a.url] = a.duration;
    }
    return byUrl;
  }, [ctx?.assets]);

  // Per extract, the EARLIER extract replaying the same footage — or null. Two
  // extracts of the same composition (or two leaves on the same file) replay the
  // same material; from the same in-point they are frame-identical, which reads as
  // the video looping instead of cutting. (montage-resume Part 1 lives here now.)
  const repeats = useMemo(() => {
    const firstByKey = new Map<string, number>();
    return extracts.map((x, i) => {
      const key = clips[i]?.url || `comp:${x.compositionId}`;
      const first = firstByKey.get(key);
      if (first === undefined) {
        firstByKey.set(key, i);
        return null;
      }
      const inAt = (j: number) => (clips[j]?.start || 0) + (extracts[j].inPoint || 0);
      return { row: first + 1, identical: Math.abs(inAt(first) - inAt(i)) < 0.05 };
    });
  }, [extracts, clips]);

  // `{ short, avail, needed, loop }` when a LEAF extract's clip falls short of its
  // window, else null. The extract's in-point eats into the available material.
  const shortfall = (k: number): Shortfall | null => {
    const c = clips[k];
    const needed = extractSecs(k);
    if (!c || needed == null) return null;
    const dur = durations[c.url];
    if (!dur) return null; // unknown duration (still loading / not a decodable clip)
    const avail = Math.max(0, (dur - c.start) / c.speed - (extracts[k].inPoint || 0));
    return avail < needed - 0.05 ? { short: needed - avail, avail, needed, loop: c.loop } : null;
  };

  // Card-level roll-up: how many extracts are short, and how many SECONDS of black
  // that costs (a looping clip is short but never goes black).
  const shortRows = useMemo(() => {
    const rows: { row: number; short: number }[] = [];
    let black = 0;
    let looping = 0;
    extracts.forEach((_x, k) => {
      const sf = shortfall(k);
      if (!sf) return;
      rows.push({ row: k + 1, short: sf.short });
      if (sf.loop) looping++;
      else black += sf.short;
    });
    return { n: rows.length, rows, black, looping };
    // `shortfall` closes over clips/durations/cuts; those are the real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extracts, clips, durations, cuts, fps]);

  // Timeline COVERAGE: which stretches of the window have material, and which
  // will render BLACK (a leaf clip out of material with loop off, or a dangling
  // reference). Same numbers the render uses — starts/shortfall — cut into bands
  // the breakpoints timeline shades, so the black spots read at a glance.
  const coverage = useMemo(() => {
    if (!cuts) return [];
    const bands: { from: number; to: number; kind: "covered" | "black"; extract: number }[] = [];
    cuts.starts.forEach((s, k) => {
      const e = k + 1 < cuts.starts.length ? cuts.starts[k + 1] : cuts.total;
      if (e <= s) return;
      if (!comps[k]) {
        bands.push({ from: s, to: e, kind: "black", extract: k }); // dangling reference
        return;
      }
      const sf = shortfall(k);
      if (sf && !sf.loop) {
        const availEnd = Math.min(e, s + Math.max(0, Math.round(sf.avail * fps)));
        if (availEnd > s) bands.push({ from: s, to: availEnd, kind: "covered", extract: k });
        if (availEnd < e) bands.push({ from: availEnd, to: e, kind: "black", extract: k });
        return;
      }
      bands.push({ from: s, to: e, kind: "covered", extract: k });
    });
    return bands;
    // `shortfall` closes over clips/durations/cuts; those are the real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cuts, comps, clips, durations, extracts, fps]);

  return {
    extracts,
    comps,
    cuts,
    fps,
    coverage,
    extractSecs,
    extractLabel,
    clips,
    durations,
    repeats,
    shortfall,
    shortRows,
  };
}
