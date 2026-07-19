import { describe, it, expect } from "vitest";

import { displayNode, toDisplay, layoutForMode } from "../components/animation/useGraphEditor";
import type { Graph, GraphNode } from "../lib/types";

// The per-view position machinery (GRAPH_VERSION 20): `x/y` is the DETAILED position,
// `cx/cy` the COMPACT one. In compact mode the canvas is handed a DISPLAY graph whose
// x/y ARE the compact coords, and commits are translated back. GraphCanvas stays
// position-agnostic, which is what makes this worth having — and what makes it easy to
// break invisibly.
//
// Both failure modes are silent. A broken WeakMap round-trip doesn't throw, it just
// hands React.memo a new object every render and every card re-renders (this repo has
// already shipped one editor-is-slow bug of exactly that shape). A broken mode switch
// doesn't throw either, it scrambles a layout the user arranged by hand.

const node = (over: Partial<GraphNode> = {}): GraphNode =>
  ({ id: "n1", type: "fluid", x: 10, y: 20, data: {}, ...over }) as GraphNode;

describe("displayNode", () => {
  it("returns the SAME object when the compact position matches the detailed one", () => {
    // No translation needed, so no new object — the cheapest path stays allocation-free.
    const n = node({ x: 10, y: 20, cx: 10, cy: 20 });
    expect(displayNode(n)).toBe(n);
  });

  it("returns the same object when there is no compact position at all", () => {
    const n = node({ x: 10, y: 20 });
    expect(displayNode(n)).toBe(n);
  });

  it("projects cx/cy onto x/y when they differ", () => {
    const n = node({ x: 10, y: 20, cx: 99, cy: 88 });
    const d = displayNode(n);
    expect([d.x, d.y]).toEqual([99, 88]);
    expect(d.cx).toBe(99); // the compact fields ride along untouched
  });

  it("is STABLE: the same node maps to the same display object every call", () => {
    // This is the whole point of the WeakMap. Without it React.memo sees a new object
    // on every render and no card can ever skip one.
    const n = node({ x: 10, y: 20, cx: 99, cy: 88 });
    expect(displayNode(n)).toBe(displayNode(n));
  });

  it("gives DIFFERENT nodes different display objects", () => {
    const a = node({ id: "a", cx: 1, cy: 1 });
    const b = node({ id: "b", cx: 2, cy: 2 });
    expect(displayNode(a)).not.toBe(displayNode(b));
  });
});

describe("toDisplay", () => {
  it("returns the SAME graph object when no node needs translating", () => {
    // Referential stability all the way up: an unchanged graph must not invalidate
    // every downstream memo.
    const g = { nodes: [node({ x: 1, y: 2 })], edges: [] } as unknown as Graph;
    expect(toDisplay(g)).toBe(g);
  });

  it("returns a new graph when any node translates, preserving untranslated identities", () => {
    const plain = node({ id: "plain", x: 1, y: 2 });
    const shifted = node({ id: "shifted", x: 1, y: 2, cx: 50, cy: 60 });
    const g = { nodes: [plain, shifted], edges: [] } as unknown as Graph;
    const out = toDisplay(g);

    expect(out).not.toBe(g);
    expect(out.nodes[0]).toBe(plain); // untouched node keeps its identity
    expect([out.nodes[1].x, out.nodes[1].y]).toEqual([50, 60]);
  });
});

describe("layoutForMode", () => {
  const far = (id: string, x: number, y: number) => node({ id, x, y });

  it("leaves a graph of fewer than two cards alone", () => {
    const one = [far("a", 0, 0)];
    expect(layoutForMode(one, "compact")).toBe(one);
    expect(layoutForMode([], "detailed")).toEqual([]);
  });

  it("seeds compact positions on first entry, without touching x/y", () => {
    // No card has cx yet -> the "tighten" branch. Whatever it computes, the DETAILED
    // coordinates are canonical and must survive a trip through compact mode.
    const nodes = [far("a", 0, 0), far("b", 900, 700)];
    const out = layoutForMode(nodes, "compact");

    expect(out.every((n) => n.cx != null && n.cy != null)).toBe(true);
    expect(out.map((n) => [n.x, n.y])).toEqual([
      [0, 0],
      [900, 700],
    ]);
  });

  it("keeps an existing compact layout that has no collisions", () => {
    // "an existing compact layout only moves where cards would collide" — so a
    // hand-arranged compact view must come back untouched, node identities included.
    const nodes = [
      node({ id: "a", x: 0, y: 0, cx: 0, cy: 0 }),
      node({ id: "b", x: 0, y: 0, cx: 4000, cy: 4000 }),
    ];
    const out = layoutForMode(nodes, "compact");
    expect(out[0]).toBe(nodes[0]);
    expect(out[1]).toBe(nodes[1]);
  });

  it("de-overlaps detailed positions and leaves a clean layout identical", () => {
    const clean = [far("a", 0, 0), far("b", 4000, 4000)];
    expect(layoutForMode(clean, "detailed").map((n) => [n.x, n.y])).toEqual([
      [0, 0],
      [4000, 4000],
    ]);

    // Two cards stacked at the same point must not stay stacked.
    const stacked = [far("a", 0, 0), far("b", 0, 0)];
    const out = layoutForMode(stacked, "detailed");
    expect([out[0].x, out[0].y]).not.toEqual([out[1].x, out[1].y]);
  });

  it("writes compact collisions to cx/cy and never to x/y", () => {
    // The bug this guards: resolving a COMPACT collision by moving the DETAILED
    // coordinate silently rearranges the other view.
    const stacked = [
      node({ id: "a", x: 111, y: 222, cx: 0, cy: 0 }),
      node({ id: "b", x: 333, y: 444, cx: 0, cy: 0 }),
    ];
    const out = layoutForMode(stacked, "compact");

    expect(out.map((n) => [n.x, n.y])).toEqual([
      [111, 222],
      [333, 444],
    ]);
    expect([out[0].cx, out[0].cy]).not.toEqual([out[1].cx, out[1].cy]);
  });
});
