import { useMemo } from "react";
import { useResolvedCurve } from "./useResolvedCurve";
import { upstreamKey } from "../../../lib/graphModel";
import { riseFrames } from "../../../lib/imageCount";
import {
  cutMarks,
  clampedFades,
  effectiveCuts,
  lyricCuts,
  partStarts,
} from "../../../lib/cutSchedule";
import type { DreamData, GraphNode } from "../../../lib/types";
import type { NodeCtx } from "./nodeProps";

// Everything the Dream card derives from its prompts + the trigger's resolved curve +
// manual breakpoints: the effective cut schedule, one band per PART, and the clamped
// fade ramps between them.
//
// This is the montage's `useMontageShortfall` cut half, over prompts instead of
// extracts — same helpers (`cutMarks`/`effectiveCuts`/`partStarts`), so the timeline and
// the render cannot disagree about where a cut lands. What it adds is the fade geometry:
// the ramps must be drawn CLAMPED, because `dream_plan` scales an over-long fade down to
// the part's own duration and drawing the requested value would be a lie about the render.
export function useDreamSchedule(node: GraphNode, ctx: NodeCtx | undefined) {
  const d = node.data as DreamData;
  const graph = ctx?.graph;
  const rawPrompts = d.prompts;
  const prompts = useMemo(() => rawPrompts || [], [rawPrompts]);
  const spans = useMemo(() => prompts.map((p) => Math.max(1, Math.round(p.span || 1))), [prompts]);

  const triggerBinding = d.ports?.trigger?.binding;
  const triggerSrc = triggerBinding?.kind === "node" ? triggerBinding.nodeId : null;
  // `fps` is the CURVE's sampling rate (echoed by /resolve) — frame→seconds must use it,
  // not the project fps (the montage's 25%-late-boundary bug).
  const { curve, fps: curveFps } = useResolvedCurve(
    triggerSrc ? ctx : undefined,
    triggerSrc || "",
    triggerSrc && graph ? upstreamKey(graph, triggerSrc, ctx?.segment?.signals) : ""
  );

  // The lyric lines ride in with the project, not over an edge — the same way the
  // Lyrics card gets them (a card has one outFlow, and Lyrics' is already `video`).
  const lyricsKey = ctx?.lyricsKey || "";
  const rawLines = ctx?.lyricLines;
  const manualJson = JSON.stringify(d.manualBreakpoints || []);
  const disabledJson = JSON.stringify(d.disabledCuts || []);
  const promptsJson = JSON.stringify(prompts);

  const sched = useMemo(() => {
    const haveCurve = !!triggerSrc && curve.length > 0;
    const fps = haveCurve ? curveFps : ctx?.output?.fps || 24;
    const segLen = Math.max(0.001, (ctx?.segment?.end ?? 0) - (ctx?.segment?.start ?? 0) || 0.001);
    const total = haveCurve ? curve.length : Math.max(1, Math.round(segLen * fps));
    // Unlike the montage, a schedule with NO cuts at all is still valid and useful: one
    // prompt over the whole window is the simplest working configuration, so the
    // timeline always renders rather than bailing to null.
    const gateRises = haveCurve ? riseFrames(curve, d.threshold, d.hysteresis) : [];
    const lyr = d.followLyrics
      ? lyricCuts(rawLines, ctx?.segment?.start ?? 0, fps, total, {
          skipUnaligned: d.skipUnaligned,
        })
      : [];
    const frames = effectiveCuts(
      gateRises,
      d,
      fps,
      total,
      lyr.map((c) => c.frame)
    );
    const starts = partStarts(frames, spans);
    const fades = clampedFades(prompts, starts, total, fps);
    return {
      frames,
      rises: frames.length,
      starts,
      fades,
      marks: cutMarks(
        gateRises,
        d,
        fps,
        total,
        lyr.map((c) => c.frame)
      ),
      // Which cuts OPEN a silence — the parts that want the instrumental prompt.
      gapFrames: lyr.filter((c) => c.gap).map((c) => c.frame),
      total,
      fps,
    };
    // manual/disabled/prompts ride as JSON so an in-place data edit still recomputes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    curve,
    curveFps,
    triggerSrc,
    d.threshold,
    d.hysteresis,
    manualJson,
    disabledJson,
    promptsJson,
    lyricsKey,
    d.followLyrics,
    d.skipUnaligned,
    spans,
    ctx?.output?.fps,
    ctx?.segment?.start,
    ctx?.segment?.end,
  ]);

  // One band per PLAYED part, plus the transition ramps between them. A prompt beyond
  // the last cut never plays; it keeps its row (badged "unused" — eating someone's
  // typing because their trigger isn't wired yet would be unforgivable) but has no band.
  const bands = useMemo(() => {
    const { starts, total, fps, fades } = sched;
    return starts.map((s, k) => {
      const end = k + 1 < starts.length ? starts[k + 1] : total;
      // The transition INTO this part spans [c - fadeOut(k-1), c + fadeIn(k)] and the
      // one OUT of it [c' - fadeOut(k), c' + fadeIn(k+1)] — the clamp guarantees they
      // cannot overlap, so a band's solid middle is always non-negative.
      const inFrom = k > 0 ? s - Math.round(fades[k - 1].fadeOut * fps) : s;
      const inTo = k > 0 ? s + Math.round(fades[k].fadeIn * fps) : s;
      const outFrom = k + 1 < starts.length ? end - Math.round(fades[k].fadeOut * fps) : end;
      const outTo = k + 1 < starts.length ? end + Math.round(fades[k + 1].fadeIn * fps) : end;
      return {
        part: k,
        from: s,
        to: end,
        inFrom,
        inTo,
        outFrom,
        outTo,
        clamped: fades[k].clamped,
        secs: (end - s) / fps,
      };
    });
  }, [sched]);

  // The label for prompt k: window-local start–end seconds, so each row reads as a
  // timeline slice. "unused" = fewer cuts than prompts (it never plays).
  const promptLabel = (k: number): string => {
    const { starts, total, fps } = sched;
    if (k >= starts.length) return "unused";
    const end = k + 1 < starts.length ? starts[k + 1] : total;
    const t = (f: number) => (f / fps).toFixed(1);
    return `${t(starts[k])} – ${t(end)}s`;
  };

  return { prompts, sched, bands, promptLabel, fps: sched.fps, hasTrigger: !!triggerSrc };
}
