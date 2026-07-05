// Text wrap + auto-fit for the lyrics box PREVIEW — a JS mirror of backend
// `sources.py` `_wrap`/`_fit`: shrink the font until the wrapped block (with its outline
// stroke) fits the box in both width and height. Pure (measurement is injected), so it's
// unit-testable and reused by the canvas drawing in BoxPad. The backend render stays the
// source of truth; this only needs to be close enough to place/size the box confidently.

export interface FitResult {
  px: number;
  lines: string[];
  lineH: number;
}

// Greedy word-wrap to `maxW` (a lone over-long word keeps its own line).
export function wrapText(text: string, maxW: number, measure: (t: string) => number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const trial = cur ? `${cur} ${word}` : word;
    if (!cur || measure(trial) <= maxW) cur = trial;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

// Shrink from `px0` until the wrapped block + stroke fits `boxW`×`boxH`.
// `measure(text, px)` -> pixel width; `lineHeight(px)` -> line height at that size.
export function fitText(
  text: string,
  boxW: number,
  boxH: number,
  strokeFrac: number,
  measure: (t: string, px: number) => number,
  lineHeight: (px: number) => number,
  px0: number
): FitResult {
  let px = Math.max(6, Math.floor(px0));
  for (;;) {
    const sw = Math.max(0, strokeFrac * px);
    const lines = wrapText(text, boxW - 2 * sw, (t) => measure(t, px));
    const lineH = lineHeight(px);
    const totalH = lineH * lines.length + 2 * sw;
    const widest = lines.reduce((m, l) => Math.max(m, measure(l, px)), 0) + 2 * sw;
    if (px <= 6 || (totalH <= boxH && widest <= boxW)) return { px, lines, lineH };
    px = px > 24 ? Math.floor(px * 0.9) : px - 1;
    if (px < 6) px = 6;
  }
}
