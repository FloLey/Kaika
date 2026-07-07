import { describe, it, expect } from "vitest";
import { estimateCardSize, resolveOverlaps, tighten } from "../lib/graph/layout";
import type { LayoutRect } from "../lib/graph/layout";

// The per-view layout passes (v20). The user-facing contract under test:
// resolveOverlaps NEVER moves a clean layout (switching views must not scramble a
// hand-tuned arrangement) and always ends overlap-free; tighten packs cards closer
// without creating overlaps. jsdom has no real layout, so these pure-geometry tests
// carry the coverage — the DOM tests only check the wiring.

const overlapping = (rects: LayoutRect[], pos: Map<string, { x: number; y: number }>, gap = 16) => {
  const placed = rects.map((r) => ({ ...r, ...pos.get(r.id)! }));
  const pairs: string[] = [];
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i];
      const b = placed[j];
      const px = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) + gap;
      const py = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) + gap;
      if (px > 0 && py > 0) pairs.push(`${a.id}/${b.id}`);
    }
  }
  return pairs;
};

describe("resolveOverlaps", () => {
  it("is a strict no-op on a layout that is already clean", () => {
    const rects: LayoutRect[] = [
      { id: "a", x: 0, y: 0, w: 100, h: 80 },
      { id: "b", x: 200.5, y: 10, w: 100, h: 80 }, // fractional coords survive exactly
      { id: "c", x: 0, y: 300, w: 100, h: 80 },
    ];
    const pos = resolveOverlaps(rects);
    for (const r of rects) expect(pos.get(r.id)).toEqual({ x: r.x, y: r.y });
  });

  it("separates a fully stacked pile (the compact→detailed switch case)", () => {
    // Five big cards on nearly the same spot — what a tight compact arrangement
    // looks like once every card grows to its detailed footprint.
    const rects: LayoutRect[] = Array.from({ length: 5 }, (_, i) => ({
      id: `n${i}`,
      x: i * 30,
      y: i * 20,
      w: 230,
      h: 300,
    }));
    const pos = resolveOverlaps(rects);
    expect(overlapping(rects, pos)).toEqual([]);
  });

  it("moves only the colliding cards, minimally, and keeps relative order", () => {
    const rects: LayoutRect[] = [
      { id: "left", x: 0, y: 0, w: 100, h: 100 },
      { id: "right", x: 60, y: 10, w: 100, h: 100 }, // overlaps `left`
      { id: "far", x: 1000, y: 1000, w: 100, h: 100 }, // nowhere near the others
    ];
    const pos = resolveOverlaps(rects);
    expect(overlapping(rects, pos)).toEqual([]);
    // The distant card never moved.
    expect(pos.get("far")).toEqual({ x: 1000, y: 1000 });
    // Left stays left of right (order preserved), and neither teleported.
    expect(pos.get("left")!.x).toBeLessThan(pos.get("right")!.x);
    expect(Math.abs(pos.get("left")!.x - 0)).toBeLessThan(150);
    expect(Math.abs(pos.get("right")!.x - 60)).toBeLessThan(150);
  });

  it("separates two cards dropped on the exact same spot", () => {
    const rects: LayoutRect[] = [
      { id: "a", x: 50, y: 50, w: 200, h: 80 },
      { id: "b", x: 50, y: 50, w: 200, h: 80 },
    ];
    expect(overlapping(rects, resolveOverlaps(rects))).toEqual([]);
  });
});

describe("tighten", () => {
  it("packs a spread layout closer without creating overlaps", () => {
    // A detailed-spaced arrangement, then compact-sized cards: lots of dead space.
    const rects: LayoutRect[] = [
      { id: "a", x: 0, y: 0, w: 200, h: 80 },
      { id: "b", x: 500, y: 0, w: 200, h: 80 },
      { id: "c", x: 0, y: 600, w: 200, h: 80 },
      { id: "d", x: 500, y: 600, w: 200, h: 80 },
    ];
    const pos = tighten(rects);
    expect(overlapping(rects, pos)).toEqual([]);
    const span = (p: Map<string, { x: number; y: number }>) => {
      const xs = rects.map((r) => p.get(r.id)!.x);
      const ys = rects.map((r) => p.get(r.id)!.y);
      return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    };
    const before = new Map(rects.map((r) => [r.id, { x: r.x, y: r.y }]));
    expect(span(pos)).toBeLessThan(span(before));
    // Relative order survives the packing.
    expect(pos.get("a")!.x).toBeLessThan(pos.get("b")!.x);
    expect(pos.get("a")!.y).toBeLessThan(pos.get("c")!.y);
  });

  it("leaves a single card alone", () => {
    const rects: LayoutRect[] = [{ id: "solo", x: 42, y: 7, w: 200, h: 80 }];
    expect(tighten(rects).get("solo")).toEqual({ x: 42, y: 7 });
  });
});

describe("estimateCardSize", () => {
  it("compact estimates are one small footprint; output never compacts", () => {
    expect(estimateCardSize("fluid", "compact")).toEqual(estimateCardSize("lfo", "compact"));
    expect(estimateCardSize("output", "compact")).toEqual(estimateCardSize("output", "detailed"));
  });

  it("detailed estimates differ by card type with a default fallback", () => {
    expect(estimateCardSize("fluid", "detailed").h).toBeGreaterThan(
      estimateCardSize("lfo", "detailed").h
    );
    expect(estimateCardSize("unknown-card", "detailed").w).toBeGreaterThan(0);
  });
});
