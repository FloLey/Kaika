// The montage's effective cut schedule — the frontend mirror of backend
// `graph_render._effective_cuts` / `_montage_starts`. The two must agree or the
// strip/timeline preview lies about where the render will cut.
//
// Effective cuts = GATE rises (the trigger through the card's built-in hysteresis
// threshold — `riseFrames`) minus the individually DISABLED ones, unioned with the
// MANUAL breakpoints; sorted, deduped at frame granularity, clamped inside
// (0, nframes). `disabledCuts`/breakpoint times are composition-LOCAL seconds; a
// disabled entry suppresses ANY cut within HALF A FRAME of it — gate or MANUAL
// (deterministic, and a gate cut that MOVED under a threshold edit re-enables
// itself). Manuals must obey too (v17): one sharing a disabled gate cut's frame
// used to resurrect the cut backend-side while this mirror said it was silenced.

import type { MontageData } from "./types";

// One mark for the breakpoints timeline: where, from which source, and whether a
// gate cut is currently disabled (drawn greyed/struck, still visible — provenance).
export interface CutMark {
  frame: number;
  source: "gate" | "manual";
  disabled: boolean;
  breakpointId?: string; // manual only — the row to move/delete
}

export function cutMarks(
  gateRises: number[],
  data: Pick<MontageData, "manualBreakpoints" | "disabledCuts">,
  fps: number,
  nframes: number
): CutMark[] {
  const half = 0.5;
  const disabledFrames = (data.disabledCuts || []).map((t) => t * fps);
  const marks: CutMark[] = [];
  const taken = new Set<number>();
  for (const r of gateRises) {
    if (r < 1 || r >= nframes) continue;
    marks.push({
      frame: r,
      source: "gate",
      disabled: disabledFrames.some((f) => Math.abs(r - f) <= half),
    });
    taken.add(r);
  }
  for (const bp of data.manualBreakpoints || []) {
    const f = Math.round(bp.t * fps);
    if (f < 1 || f >= nframes) continue;
    // Same-frame collision: the gate mark wins the pixel (provenance display); the
    // manual row still exists in the data and stays editable from the list.
    if (taken.has(f)) continue;
    marks.push({
      frame: f,
      source: "manual",
      // A disabled entry silences manuals too — mirror of _effective_cuts (v17).
      disabled: disabledFrames.some((df) => Math.abs(f - df) <= half),
      breakpointId: bp.id,
    });
  }
  return marks.sort((a, b) => a.frame - b.frame);
}

// The frames the render actually cuts at (enabled marks only, deduped).
export function effectiveCuts(
  gateRises: number[],
  data: Pick<MontageData, "manualBreakpoints" | "disabledCuts">,
  fps: number,
  nframes: number
): number[] {
  return cutMarks(gateRises, data, fps, nframes)
    .filter((m) => !m.disabled)
    .map((m) => m.frame);
}

// Absolute start frame of each PLAYED extract (mirrors backend `_montage_starts`):
// frame 0 always starts extract 0; extract k swallows spans[k] cuts before the next
// starts; an extract whose starting cut never arrives holds — the last STARTED one
// runs to the window end.
export function montageStarts(cuts: number[], spans: number[]): number[] {
  const starts = [0];
  let consumed = 0;
  for (const span of spans.slice(0, -1)) {
    consumed += span;
    if (consumed - 1 >= cuts.length) break;
    starts.push(cuts[consumed - 1]);
  }
  return starts;
}
