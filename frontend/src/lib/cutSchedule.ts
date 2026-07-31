// The cut schedule shared by the montage and Dream cards — the frontend mirror of
// backend `cut_schedule.py`. The two must agree or the strip/timeline preview lies
// about where the render will cut; `cut_schedule_cases.json` is read by BOTH suites
// so neither side can be "fixed" alone.
//
// A cut schedule splits a composition's window into parts. The montage plays one
// extract per part; Dream generates under one prompt per part.
//
// Effective cuts = GATE rises (the trigger through the card's built-in hysteresis
// threshold — `riseFrames`) minus the individually DISABLED ones, unioned with the
// MANUAL breakpoints; sorted, deduped at frame granularity, clamped inside
// (0, nframes). `disabledCuts`/breakpoint times are composition-LOCAL seconds; a
// disabled entry suppresses ANY cut within HALF A FRAME of it — gate or MANUAL
// (deterministic, and a gate cut that MOVED under a threshold edit re-enables
// itself). Manuals must obey too (v17): one sharing a disabled gate cut's frame
// used to resurrect the cut backend-side while this mirror said it was silenced.

import type { DreamPrompt, LyricLine, MontageData } from "./types";

// One mark for the breakpoints timeline: where, from which source, and whether a
// gate cut is currently disabled (drawn greyed/struck, still visible — provenance).
export interface CutMark {
  frame: number;
  source: "gate" | "manual" | "lyric";
  disabled: boolean;
  breakpointId?: string; // manual only — the row to move/delete
}

// A gap between two sung lines shorter than this is not a real silence — it is the
// padding `align_lines` adds to every `t1` for readability, clamped at the next line's
// `t0`. Mirror of backend `cut_schedule.MIN_GAP_S`.
export const MIN_GAP_S = 0.3;

export interface LyricCut {
  frame: number;
  gap: boolean; // this cut OPENS a silence rather than a sung line
}

// Cut frames derived from aligned lyric lines (Dream's "follow the lyrics"). Mirror of
// backend `cut_schedule.lyric_cuts` — see it for why only REAL silences become gap cuts
// and why the absolute→local conversion happens here and nowhere else.
export function lyricCuts(
  lines: LyricLine[] | undefined,
  segStart: number,
  fps: number,
  nframes: number,
  opts: { instrumental?: boolean; skipUnaligned?: boolean } = {}
): LyricCut[] {
  const instrumental = opts.instrumental !== false;
  const rows = (lines || [])
    .filter((l) => l && Number.isFinite(l.t0) && Number.isFinite(l.t1))
    .filter((l) => !(opts.skipUnaligned && l.aligned === false))
    .map((l) => [l.t0, l.t1] as [number, number])
    .sort((a, b) => a[0] - b[0]);

  const out: LyricCut[] = [];
  rows.forEach(([t0, t1], i) => {
    out.push({ frame: Math.round((t0 - segStart) * fps), gap: false });
    if (!instrumental) return;
    // What bounds this line's trailing silence: the next line, or — for the last one —
    // the END OF THE WINDOW.
    const next = i + 1 < rows.length ? rows[i + 1][0] : segStart + nframes / fps;
    if (next - t1 >= MIN_GAP_S) {
      out.push({ frame: Math.round((t1 - segStart) * fps), gap: true });
    }
  });
  return out.filter((c) => c.frame >= 1 && c.frame < nframes);
}

export function cutMarks(
  gateRises: number[],
  data: Pick<MontageData, "manualBreakpoints" | "disabledCuts">,
  fps: number,
  nframes: number,
  lyric: number[] = []
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
    taken.add(f);
  }
  // Lyric cuts last: on a frame already claimed by a gate or manual mark the earlier
  // provenance wins the pixel, the same collision rule manual marks follow.
  for (const f of lyric) {
    if (f < 1 || f >= nframes || taken.has(f)) continue;
    marks.push({
      frame: f,
      source: "lyric",
      disabled: disabledFrames.some((df) => Math.abs(f - df) <= half),
    });
    taken.add(f);
  }
  return marks.sort((a, b) => a.frame - b.frame);
}

// The frames the render actually cuts at (enabled marks only, deduped).
export function effectiveCuts(
  gateRises: number[],
  data: Pick<MontageData, "manualBreakpoints" | "disabledCuts">,
  fps: number,
  nframes: number,
  lyric: number[] = []
): number[] {
  return cutMarks(gateRises, data, fps, nframes, lyric)
    .filter((m) => !m.disabled)
    .map((m) => m.frame);
}

// Absolute start frame of each PLAYED extract (mirrors backend `_montage_starts`):
// frame 0 always starts extract 0; extract k swallows spans[k] cuts before the next
// starts; an extract whose starting cut never arrives holds — the last STARTED one
// runs to the window end.
export function partStarts(cuts: number[], spans: number[]): number[] {
  const starts = [0];
  let consumed = 0;
  for (const span of spans.slice(0, -1)) {
    consumed += span;
    if (consumed - 1 >= cuts.length) break;
    starts.push(cuts[consumed - 1]);
  }
  return starts;
}

// ---- Dream: the per-frame plan (mirror of backend cut_schedule.dream_plan) ---------

export interface DreamPlanStep {
  prompt_a: string;
  prompt_b: string | null;
  w: number;
  seed: number;
}

// (fadeIn, fadeOut) seconds per part, capped so `fadeIn + fadeOut <= the part's own
// duration`, both scaled proportionally on overflow.
//
// This is the invariant, not tidiness: transition k-1→k ends at `c_k + i_k`, transition
// k→k+1 begins at `c_k + D_k - o_k`, and they stay disjoint iff `i_k + o_k <= D_k`. So
// the clamp is what guarantees at most TWO prompts ever blend at once — which is what
// lets the embedding lerp take a pair and the cache key take a pair. The timeline must
// draw the CLAMPED value: showing the requested one would be a lie about the render.
export function clampedFades(
  prompts: DreamPrompt[],
  starts: number[],
  nframes: number,
  fps: number
): { fadeIn: number; fadeOut: number; clamped: boolean }[] {
  return starts.map((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : nframes;
    const dur = Math.max(0, (end - s) / fps);
    const p = prompts[k] || ({} as DreamPrompt);
    const fadeIn = Math.max(0, p.fadeIn || 0);
    const fadeOut = Math.max(0, p.fadeOut || 0);
    const total = fadeIn + fadeOut;
    if (total > dur && total > 0) {
      const scale = dur / total;
      return { fadeIn: fadeIn * scale, fadeOut: fadeOut * scale, clamped: true };
    }
    return { fadeIn, fadeOut, clamped: false };
  });
}

// Remap a linear fade fraction through the card's fade SHAPE (mirror of backend
// `_shaped`). 1.0 is the identity — a linear ramp, and the default. Above 1 the curve
// flattens around the midpoint so the fade spends most of its duration near w = 0.5.
//
// It exists because the two models do not interpolate alike: SD-Turbo morphs steadily
// across the whole sweep, but Z-Image is continuous-yet-STEEP — measured on the step-01
// probe, essentially all its change happens inside w ∈ [0.42, 0.62], so a linear ramp
// spends ~80% of an HD fade showing nothing. At shape 3 about 58% of the window lands
// inside that band. A control rather than a per-model constant on purpose: the band was
// measured on ONE prompt pair, so a hardcoded curve would be right there and silently
// wrong elsewhere.
export function fadeShaped(u: number, shape: number): number {
  if (shape === 1 || u <= 0 || u >= 1) return u;
  const s = 2 * u - 1;
  return 0.5 + 0.5 * Math.sign(s) * Math.abs(s) ** shape;
}

// Blend weight at time `t` for a transition at cut time `c` with `o` seconds of lead-out
// and `i` of lead-in. Both zero is a hard cut. Otherwise a ramp across [c-o, c+i] —
// linear at shape 1, so at the cut itself you are `o/(o+i)` of the way across.
export function blendWeight(t: number, c: number, o: number, i: number, shape: number = 1): number {
  if (o + i <= 0) return t >= c ? 1 : 0;
  if (t <= c - o) return 0;
  if (t >= c + i) return 1;
  return fadeShaped((t - (c - o)) / (o + i), shape);
}

function seedFor(f: number, seed: number, mode: string, events: number[]): number {
  if (mode === "frame") return seed + f;
  if (mode === "gate") {
    let n = 0;
    for (const e of events) {
      if (e <= f) n++;
      else break;
    }
    return seed + n;
  }
  return seed;
}

// One step per frame. `reseedFrames` null means the `reseed` port is unwired, so `gate`
// mode falls back to the CUT schedule — a fresh image family per prompt with nothing
// wired; wiring a separate signal re-rolls WITHIN a part.
export function dreamPlan(
  cuts: number[],
  prompts: DreamPrompt[],
  fps: number,
  nframes: number,
  opts: {
    seed?: number;
    seedMode?: string;
    reseedFrames?: number[] | null;
    shape?: number;
  } = {}
): DreamPlanStep[] {
  if (!prompts.length) return [];
  const n = Math.max(1, Math.round(nframes));
  const spans = prompts.map((p) => Math.max(1, Math.round(p.span || 1)));
  const starts = partStarts(cuts, spans);
  const fades = clampedFades(prompts, starts, n, fps);
  const seed = opts.seed ?? 1;
  const mode = opts.seedMode ?? "gate";
  const shape = opts.shape ?? 1;
  const events = (opts.reseedFrames ?? cuts).slice().sort((a, b) => a - b);

  const plan: DreamPlanStep[] = [];
  for (let f = 0; f < n; f++) {
    let k = 0;
    while (k + 1 < starts.length && starts[k + 1] <= f) k++;
    let a = prompts[k]?.text || "";
    let b: string | null = null;
    let w = 0;
    const t = f / fps;
    if (k > 0) {
      // the tail of the transition INTO this part
      const c = starts[k] / fps;
      const o = fades[k - 1].fadeOut;
      const i = fades[k].fadeIn;
      if (t < c + i) {
        a = prompts[k - 1]?.text || "";
        b = prompts[k]?.text || "";
        w = blendWeight(t, c, o, i, shape);
      }
    }
    if (k + 1 < starts.length) {
      // the head of the transition OUT of it
      const c = starts[k + 1] / fps;
      const o = fades[k].fadeOut;
      const i = fades[k + 1].fadeIn;
      if (o > 0 && t >= c - o) {
        a = prompts[k]?.text || "";
        b = prompts[k + 1]?.text || "";
        w = blendWeight(t, c, o, i, shape);
      }
    }
    plan.push({ prompt_a: a, prompt_b: w > 0 ? b : null, w, seed: seedFor(f, seed, mode, events) });
  }
  return plan;
}
