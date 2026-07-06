import { describe, it, expect } from "vitest";
import { countRises, fitPrompts } from "../lib/imageCount";

describe("countRises", () => {
  it("counts each 0->1 rising edge of a clean gate square", () => {
    // three pulses (0→1 three times), starting low
    expect(countRises([0, 0, 1, 1, 0, 1, 0, 0, 1, 1])).toBe(3);
  });

  it("does not count a curve that starts high (frame 0 already shows image 0)", () => {
    expect(countRises([1, 1, 0, 1, 0, 0])).toBe(1); // only the second rise counts
  });

  it("is 0 for an all-low or empty curve", () => {
    expect(countRises([0, 0, 0])).toBe(0);
    expect(countRises([])).toBe(0);
  });

  it("uses hysteresis so a signal hovering the threshold doesn't machine-gun", () => {
    // wobble around 0.5 within the default dead band [0.45, 0.55] → no new rise
    expect(countRises([0, 1, 0.5, 0.52, 0.48, 0.51])).toBe(1);
  });
});

describe("fitPrompts", () => {
  it("grows by appending empty rows", () => {
    expect(fitPrompts(["a rose"], 3)).toEqual(["a rose", "", ""]);
  });

  it("shrinks by removing only trailing empty rows", () => {
    expect(fitPrompts(["a rose", "a tree", "", ""], 2)).toEqual(["a rose", "a tree"]);
  });

  it("never deletes a typed prompt (keeps more than needed)", () => {
    expect(fitPrompts(["a rose", "a tree", "the sea"], 2)).toEqual([
      "a rose",
      "a tree",
      "the sea",
    ]);
  });

  it("keeps a typed trailing prompt even with an empty gap before it", () => {
    expect(fitPrompts(["a rose", "", "the sea"], 2)).toEqual(["a rose", "", "the sea"]);
  });

  it("always leaves at least one row", () => {
    expect(fitPrompts([], 1)).toEqual([""]);
    expect(fitPrompts(["", ""], 0)).toEqual(["", ""]); // needed<=0 is a no-op
  });
});
