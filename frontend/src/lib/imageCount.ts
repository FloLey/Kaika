// Helpers for the Image gen card's gate-driven image count.
//
// A gate card emits a clean 0/1 square; the slideshow it feeds advances one image
// per rising edge of that trigger (starting on image 0), so the number of DISTINCT
// images it shows over a segment is `rises + 1`. The Image gen card resolves the
// wired gate's actual curve (via /resolve) and uses these to size its prompt list.

// Count rising edges of a 0..1 `curve` — a 0→1 crossing of the threshold with a
// small dead band, matching the slideshow's default hysteresis so the counts agree.
// A curve that STARTS high isn't a switch (frame 0 already shows image 0), mirroring
// `_slideshow_index` (backend) and the SlideshowNode switch counter.
export function countRises(curve: number[], threshold = 0.5, hysteresis = 0.1): number {
  const hi = Math.min(1, threshold + hysteresis / 2);
  const lo = Math.max(0, threshold - hysteresis / 2);
  let state = 0;
  let rises = 0;
  let first = true;
  for (const v of curve) {
    if (state === 0 && v >= hi) {
      state = 1;
      if (!first) rises += 1;
    } else if (state === 1 && v < lo) {
      state = 0;
    }
    first = false;
  }
  return rises;
}

// Non-destructively resize a prompt list to `needed` rows:
//  - grow by appending empty rows;
//  - shrink by removing only TRAILING EMPTY rows (never a typed prompt), so if you
//    have more typed prompts than the gate needs they're all kept.
// Always leaves at least one row.
export function fitPrompts(prompts: string[], needed: number): string[] {
  const p = prompts.length ? [...prompts] : [""];
  if (!Number.isFinite(needed) || needed <= 0) return p;
  while (p.length < needed) p.push("");
  while (p.length > needed && !p[p.length - 1].trim()) p.pop();
  return p.length ? p : [""];
}
