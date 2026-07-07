import { describe, it, expect } from "vitest";
import { fitView } from "../components/animation/usePanZoom";

// ⊙ fit view: the pure bbox -> {tx, ty, scale} math (usePanZoom.fitView).
describe("fitView", () => {
  const vp = { width: 1000, height: 500 };

  it("centers a small bbox at 1:1 (never zooms IN past natural size)", () => {
    const v = fitView({ minX: 0, minY: 0, maxX: 200, maxY: 100 }, vp);
    expect(v.scale).toBe(1);
    expect(v.tx).toBe((1000 - 200) / 2);
    expect(v.ty).toBe((500 - 100) / 2);
  });

  it("zooms out to fit a large bbox with the 5% margin", () => {
    const v = fitView({ minX: 0, minY: 0, maxX: 2000, maxY: 400 }, vp);
    expect(v.scale).toBeCloseTo((1000 * 0.9) / 2000, 5); // width-limited
    // centered: the box's midpoint (graph x=1000) lands on the viewport midpoint
    expect(1000 * v.scale + v.tx).toBeCloseTo(500, 3);
  });

  it("fits a huge sprawl — no static floor (fit must ALWAYS fit)", () => {
    const v = fitView({ minX: 0, minY: 0, maxX: 20000, maxY: 4000 }, vp);
    expect(v.scale).toBeCloseTo((1000 * 0.9) / 20000, 5); // well below the old 0.15 floor
    // everything is inside the viewport
    expect(0 * v.scale + v.tx).toBeGreaterThanOrEqual(0);
    expect(20000 * v.scale + v.tx).toBeLessThanOrEqual(1000);
  });

  it("floors only against degenerate math (absurd extents)", () => {
    const v = fitView({ minX: -5e6, minY: -5e6, maxX: 5e6, maxY: 5e6 }, vp);
    expect(v.scale).toBe(0.01); // FLOOR_SCALE — never collapses to zero
  });

  it("recovers an off-screen bbox (negative coordinates)", () => {
    const v = fitView({ minX: -5000, minY: -3000, maxX: -4700, maxY: -2800 }, vp);
    // the card's centre maps into the viewport
    const cx = (-5000 + -4700) / 2;
    const cy = (-3000 + -2800) / 2;
    expect(cx * v.scale + v.tx).toBeGreaterThan(0);
    expect(cx * v.scale + v.tx).toBeLessThan(1000);
    expect(cy * v.scale + v.ty).toBeGreaterThan(0);
    expect(cy * v.scale + v.ty).toBeLessThan(500);
  });
});
