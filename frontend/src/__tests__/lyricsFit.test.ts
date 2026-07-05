import { describe, it, expect } from "vitest";
import { wrapText, fitText } from "../lib/lyricsFit";

// Fake metrics: width ≈ chars * px * 0.5; line height ≈ px * 1.2.
const measure = (t: string, px: number) => t.length * px * 0.5;
const lineHeight = (px: number) => px * 1.2;

describe("lyricsFit", () => {
  it("wraps to the width, keeping a lone over-long word on its own line", () => {
    const m = (t: string) => t.length; // 1px per char
    expect(wrapText("aa bb cc dd", 5, m)).toEqual(["aa bb", "cc dd"]);
    expect(wrapText("supercalifragilistic", 5, m)).toEqual(["supercalifragilistic"]);
  });

  it("keeps a big box at the starting size but shrinks to fit a small one", () => {
    expect(fitText("hello world", 1000, 1000, 0, measure, lineHeight, 200).px).toBe(200);

    const small = fitText("hello world this is a long line", 60, 40, 0, measure, lineHeight, 200);
    expect(small.px).toBeLessThan(200);
    for (const l of small.lines) expect(measure(l, small.px)).toBeLessThanOrEqual(60);
    expect(small.lineH * small.lines.length).toBeLessThanOrEqual(40 + 1e-6);
  });

  it("leaves room for the outline stroke (a stroke -> a smaller font)", () => {
    const bare = fitText("HELLO", 100, 100, 0, measure, lineHeight, 100).px;
    const stroked = fitText("HELLO", 100, 100, 0.2, measure, lineHeight, 100).px;
    expect(stroked).toBeLessThanOrEqual(bare);
  });
});
