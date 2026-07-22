import { describe, it, expect } from "vitest";
import { FLOW_GAPS, estimateCardSize, flowLayout, resolveOverlaps } from "../lib/graph/layout";
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

describe("flowLayout (✨ arrange v2)", () => {
  const box = (id: string, x = 0, y = 0, w = 200, h = 100): LayoutRect => ({ id, x, y, w, h });
  const e = (source: string, target: string) => ({ source, target });
  const GAP = { x: 100, y: 60 };

  it("orders columns along the data flow with at least the x gap between them", () => {
    const items = [box("c", 0, 0), box("a", 500, 200), box("b", 250, 100)];
    const pos = flowLayout(items, [e("a", "b"), e("b", "c")], GAP);
    const a = pos.get("a")!;
    const b = pos.get("b")!;
    const c = pos.get("c")!;
    expect(a.x + 200 + GAP.x).toBeLessThanOrEqual(b.x + 0.001); // source column left of its target
    expect(b.x + 200 + GAP.x).toBeLessThanOrEqual(c.x + 0.001);
  });

  it("untangles a crossing (a→d, b→c with the orders inverted)", () => {
    // a above b in column 0; c above d in column 1 — the wires form an X.
    const items = [box("a", 0, 0), box("b", 0, 200), box("c", 300, 0), box("d", 300, 200)];
    const edges = [e("a", "d"), e("b", "c")];
    const pos = flowLayout(items, edges, GAP);
    // After the greedy pass one side's order flips: each wire's endpoints keep the
    // same relative order → 0 crossings.
    const sign = (p: number, q: number) => Math.sign(p - q);
    expect(sign(pos.get("a")!.y, pos.get("b")!.y)).toBe(sign(pos.get("d")!.y, pos.get("c")!.y));
  });

  it("keeps at least the gaps between cards (roomier than the de-overlap pass)", () => {
    const items = [box("a"), box("b"), box("s", 0, 50), box("t", 0, 150)];
    const edges = [e("s", "t")]; // a,b unwired -> column 0 alongside s
    const pos = flowLayout(items, edges, GAP);
    const placed = items.map((r) => ({ ...r, ...pos.get(r.id)! }));
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const A = placed[i];
        const B = placed[j];
        const sepX = Math.max(A.x, B.x) - Math.min(A.x + A.w, B.x + B.w);
        const sepY = Math.max(A.y, B.y) - Math.min(A.y + A.h, B.y + B.h);
        // Separated by the full gap on at least one axis.
        expect(Math.max(sepX - GAP.x, sepY - GAP.y)).toBeGreaterThanOrEqual(-0.001);
      }
    }
  });

  it("is deterministic (same input twice gives identical output)", () => {
    const items = [box("a", 3, 9), box("b", 3, 9), box("c", 7, 1), box("d", 2, 8)];
    const edges = [e("a", "c"), e("b", "c"), e("b", "d")];
    const p1 = flowLayout(items, edges, GAP);
    const p2 = flowLayout(items, edges, GAP);
    for (const it of items) expect(p1.get(it.id)).toEqual(p2.get(it.id));
  });

  it("re-centres the result on the old arrangement's bbox centre", () => {
    const items = [box("a", 1000, 1000), box("b", 1400, 1000)];
    const pos = flowLayout(items, [e("a", "b")], GAP);
    const xs = items.map((r) => [pos.get(r.id)!.x, pos.get(r.id)!.x + r.w]).flat();
    const ys = items.map((r) => [pos.get(r.id)!.y, pos.get(r.id)!.y + r.h]).flat();
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo((1000 + 1600) / 2, 5);
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(1050, 5);
  });

  it("exposes per-mode gaps with detailed roomier than compact", () => {
    expect(FLOW_GAPS.detailed.x).toBeGreaterThan(FLOW_GAPS.compact.x);
    expect(FLOW_GAPS.detailed.y).toBeGreaterThan(FLOW_GAPS.compact.y);
  });

  it("routes a LONG wire clear of the columns it passes through (dummy nodes)", () => {
    // b→d spans two columns and v2's counter was blind to it — it happily left the
    // long wire slicing through a→m→c. With dummies it must come out untangled:
    // no straight-line intersection between any two of the three wires.
    const items = [
      box("a", 0, 0),
      box("b", 0, 200), // a above b in column 0
      box("m", 300, 0),
      box("c", 600, 200),
      box("d", 600, 0), // d above c in column 2 — the X with b→d
    ];
    const edges = [e("a", "m"), e("m", "c"), e("b", "d")];
    const pos = flowLayout(items, edges, GAP);
    const cp = (id: string) => {
      const r = items.find((i) => i.id === id)!;
      return { x: pos.get(id)!.x + r.w / 2, y: pos.get(id)!.y + r.h / 2 };
    };
    type P = { x: number; y: number };
    const orient = (p: P, q: P, r: P) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const intersects = (p1: P, p2: P, p3: P, p4: P) =>
      orient(p3, p4, p1) * orient(p3, p4, p2) < 0 && orient(p1, p2, p3) * orient(p1, p2, p4) < 0;
    const wires: [P, P][] = [
      [cp("a"), cp("m")],
      [cp("m"), cp("c")],
      [cp("b"), cp("d")],
    ];
    for (let i = 0; i < wires.length; i++) {
      for (let j = i + 1; j < wires.length; j++) {
        expect(intersects(wires[i][0], wires[i][1], wires[j][0], wires[j][1])).toBe(false);
      }
    }
  });

  it("lines wired cards up horizontally (y relaxation)", () => {
    // Column 0 stacks a+z, so a starts off-centre; b (alone in column 1, wired to
    // a) must leave its column's centre and align with a instead.
    const items = [
      box("a", 0, 0, 200, 100),
      box("z", 0, 200, 200, 100),
      box("b", 400, 100, 200, 100),
    ];
    const pos = flowLayout(items, [e("a", "b")], GAP);
    const cy = (id: string) => pos.get(id)!.y + 50;
    expect(Math.abs(cy("b") - cy("a"))).toBeLessThan(1);
  });

  it("returns exactly the input ids (dummies never leak)", () => {
    const items = [box("a"), box("m", 300), box("c", 600)];
    const pos = flowLayout(items, [e("a", "m"), e("m", "c"), e("a", "c")], GAP);
    expect([...pos.keys()].sort()).toEqual(["a", "c", "m"]);
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
