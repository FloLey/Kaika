// Static preview for the Shaper card's sparkline. The LFO and Noise cards now show
// their REAL resolved curve from the backend (see useResolvedCurve) so they match the
// Scope and the render exactly; the Shaper preview stays local because it draws the
// shaping TRANSFER curve (input 0..1 → output), not a time signal — there's no input
// to resolve when the card is dangling.

import type { GateData, ShaperData } from "./types";

const L = 64; // preview sample count
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// The Shaper's STATIC transfer curve (input 0..1 → output): invert → threshold →
// gamma → gain/offset → [lo,hi] remap. The temporal attack/release follower can't be
// shown in a transfer curve, so the preview omits it (it shapes timing, not level).
export function shaperPreview(d: ShaperData): number[] {
  const out: number[] = [];
  for (let i = 0; i < L; i++) {
    let y = i / (L - 1);
    if (d.invert) y = 1 - y;
    const th = d.threshold || 0;
    if (th > 0) y = clamp01((y - th) / Math.max(1e-6, 1 - th));
    if (d.gamma && d.gamma !== 1) y = Math.pow(clamp01(y), Math.max(1e-3, d.gamma));
    y = y * (d.gain ?? 1) + (d.offset ?? 0);
    y = clamp01(y);
    const lo = d.lo ?? 0;
    const hi = d.hi ?? 1;
    out.push(clamp01(lo + (hi - lo) * y));
  }
  return out;
}

// The Gate's preview: a sample sine swept through the SAME hysteresis logic the
// backend applies (arm at threshold + hyst/2, release below threshold - hyst/2),
// so the square wave on the card shows exactly how the thresholds will cut.
export function gatePreview(d: GateData): number[] {
  const hi = Math.min(1, (d.threshold ?? 0.5) + (d.hysteresis ?? 0.1) / 2);
  const lo = Math.max(0, (d.threshold ?? 0.5) - (d.hysteresis ?? 0.1) / 2);
  const out: number[] = [];
  let state = 0;
  for (let i = 0; i < L; i++) {
    const v = 0.5 + 0.5 * Math.sin((i / (L - 1)) * Math.PI * 4); // two demo cycles
    if (state === 0 && v >= hi) state = 1;
    else if (state === 1 && v < lo) state = 0;
    out.push(d.invert ? 1 - state : state);
  }
  return out;
}
