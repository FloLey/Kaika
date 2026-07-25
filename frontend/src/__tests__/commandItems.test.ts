import { describe, it, expect } from "vitest";
import { buildCommandItems, filterCommands, scoreCommand } from "../components/next/commandItems";
import { fluidNode, lfoNode, outputNode } from "../lib/graphModel";
import type { Graph, GraphNode, Segment, Signal } from "../lib/types";

// What ⌘K reaches and how it ranks. The point of the feature is that 35 card types
// behind seven unsearchable dropdowns become one box, so the ranking is the feature.

const g = (nodes: GraphNode[]): Graph => ({ version: 1, nodes, edges: [] });

const sig: Signal = {
  id: "sig1",
  stemKey: "bass",
  minHz: 40,
  maxHz: 120,
  feature: "energy",
  name: "bass pulse",
  attack: 5,
  release: 250,
  invert: false,
  gamma: 1,
  gain: 1,
  offset: 0,
  threshold: 0,
};

const seg = (id: string, label: string, start: number, end: number): Segment => ({
  id,
  label,
  start,
  end,
  signals: [],
});

describe("buildCommandItems", () => {
  it("offers every addable card type", () => {
    const items = buildCommandItems({ graph: g([]) });
    const adds = items.filter((i) => i.kind === "add");
    expect(adds.length).toBeGreaterThan(25);
    expect(adds.some((i) => i.label.toLowerCase().includes("fluid"))).toBe(true);
    expect(adds.some((i) => i.label.toLowerCase().includes("lyrics"))).toBe(true);
  });

  it("lists the segment's signals individually instead of a 'signal' sub-picker", () => {
    const items = buildCommandItems({ graph: g([]), signals: [sig] });
    const bass = items.find((i) => i.label === "bass pulse");
    expect(bass).toBeTruthy();
    expect(bass!.kind).toBe("add");
    expect(bass!.hint).toContain("bass");
  });

  it("lists the cards on screen by their given name, falling back to the type title", () => {
    const named = { ...fluidNode(0, 0), name: "smoke" };
    const bare = lfoNode(0, 0);
    const items = buildCommandItems({ graph: g([named, bare]) });
    const cards = items.filter((i) => i.kind === "card");
    expect(cards.map((c) => c.label)).toContain("smoke");
    expect(cards).toHaveLength(2);
    expect(cards.every((c) => c.label.length > 0)).toBe(true);
  });

  it("lists the OTHER segments — jumping to the one you're on is a no-op", () => {
    const segments = [seg("s1", "INTRO", 0, 10), seg("s2", "VERSE", 10, 30)];
    const items = buildCommandItems({ graph: g([]), segments, activeSegmentId: "s1" });
    const segs = items.filter((i) => i.kind === "segment");
    expect(segs).toHaveLength(1);
    expect(segs[0].label).toBe("VERSE");
    expect(segs[0].hint).toBe("0:10–0:30");
  });

  it("orders add before cards before segments with an empty query", () => {
    const items = buildCommandItems({
      graph: g([outputNode(0, 0)]),
      segments: [seg("s2", "VERSE", 0, 5)],
      activeSegmentId: "s1",
    });
    const kinds = items.map((i) => i.kind);
    expect(kinds.indexOf("add")).toBeLessThan(kinds.indexOf("card"));
    expect(kinds.indexOf("card")).toBeLessThan(kinds.indexOf("segment"));
  });
});

describe("scoreCommand / filterCommands", () => {
  const items = buildCommandItems({ graph: g([]) });
  const labels = (q: string) => filterCommands(items, q).map((i) => i.label.toLowerCase());

  it("ranks a label that STARTS with the query above one that merely contains it", () => {
    // The case that motivated the tiers: "co" must not offer `echo` before `color`.
    const out = labels("co");
    const color = out.findIndex((l) => l.startsWith("co"));
    const echo = out.findIndex((l) => l === "echo");
    expect(color).toBeGreaterThanOrEqual(0);
    if (echo >= 0) expect(color).toBeLessThan(echo);
  });

  it("matches on the help text too, so you can search by what a card does", () => {
    const byTerms = filterCommands(items, "simulation");
    expect(byTerms.length).toBeGreaterThan(0);
  });

  it("an empty query keeps the natural order untouched", () => {
    expect(filterCommands(items, "   ")).toEqual(items);
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(filterCommands(items, "zzzznope")).toEqual([]);
  });

  it("scores a non-match at zero", () => {
    expect(scoreCommand(items[0], "zzzznope")).toBe(0);
  });

  it("prefers the shorter label when both start with the query", () => {
    const short = { ...items[0], label: "fire", terms: "fire" };
    const long = { ...items[0], label: "firestorm deluxe", terms: "firestorm deluxe" };
    expect(scoreCommand(short, "fir")).toBeGreaterThan(scoreCommand(long, "fir"));
  });
});
