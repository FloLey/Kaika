import { describe, it, expect } from "vitest";
import { ratioLabel, fitToRatio, aspectOf } from "../lib/output";

describe("output ratio helpers", () => {
  it("ratioLabel reduces to a w : h label", () => {
    expect(ratioLabel({ width: 1920, height: 1080 })).toBe("16 : 9");
    expect(ratioLabel({ width: 1080, height: 1920 })).toBe("9 : 16");
    expect(ratioLabel({ width: 1080, height: 1080 })).toBe("1 : 1");
    expect(ratioLabel({ width: 1000, height: 1600 })).toBe("5 : 8");
  });

  it("aspectOf gives a CSS aspect string", () => {
    expect(aspectOf({ width: 1920, height: 1080 })).toBe("1920 / 1080");
  });

  it("fitToRatio snaps a size onto a ratio, keeping the longer edge", () => {
    // portrait export -> landscape canvas (16:9): keep the 1920 long edge
    expect(fitToRatio({ width: 1080, height: 1920 }, 16 / 9)).toEqual({
      width: 1920,
      height: 1080,
    });
    // landscape export -> portrait canvas (9:16)
    expect(fitToRatio({ width: 1920, height: 1080 }, 9 / 16)).toEqual({
      width: 1080,
      height: 1920,
    });
    // square canvas
    expect(fitToRatio({ width: 1000, height: 2000 }, 1)).toEqual({ width: 2000, height: 2000 });
  });

  it("fitToRatio leaves an already-matching size unchanged", () => {
    const s = { width: 1080, height: 1920 };
    expect(fitToRatio(s, 1080 / 1920)).toEqual(s);
  });

  it("fitToRatio clamps to render bounds", () => {
    const r = fitToRatio({ width: 9000, height: 200 }, 16 / 9);
    expect(r.width).toBeLessThanOrEqual(4096);
    expect(r.height).toBeGreaterThanOrEqual(16);
  });
});
