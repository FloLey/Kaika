import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import renderAnimNode from "../components/animation/renderAnimNode";
import {
  NODE_TYPES,
  PALETTE_CATEGORIES,
  paletteMenu,
  paletteSpecs,
  chromeFor,
} from "../components/animation/nodes/registry";
import { signalNode, VIDEO_PRODUCERS, normalizeGraph, emptyGraph } from "../lib/graphModel";
import type { GraphNode } from "../lib/types";
import type { NodeCtx } from "../components/animation/nodes/nodeProps";

const helpers = {
  portRef: () => () => {},
  startConnect: () => {},
  onTitlePointerDown: () => {},
  selected: false,
};

// The registry IS the contract for adding a node type: each entry must be
// self-consistent and round-trip (factory -> renderAnimNode -> a real card), so a
// new type is provably just a Component + one registry entry (+ a backend handler).
describe("node-type registry", () => {
  it("every entry's key matches its declared type and carries a Component + chrome", () => {
    for (const [key, spec] of Object.entries(NODE_TYPES)) {
      expect(spec.type).toBe(key);
      expect(spec.Component).toBeTruthy();
      expect(spec.chrome.title).toBeTruthy();
      expect(spec.chrome.outFlow).toMatch(/^(value|video|points|color|images)$/);
    }
  });

  it("each palette spec's factory produces a node of its own type, ordered", () => {
    const specs = paletteSpecs();
    expect(specs.length).toBeGreaterThan(0);
    const orders = specs.map((s) => s.palette!.order);
    expect([...orders]).toEqual([...orders].sort((a, b) => a - b)); // sorted
    for (const spec of specs) {
      const node = spec.factory!(0, 0);
      expect(node.type).toBe(spec.type);
      expect(node.id).toMatch(/^n-/);
    }
  });

  it("every palette entry's category is a real menu section (nothing hides off-menu)", () => {
    const known = new Set(PALETTE_CATEGORIES.map((c) => c.key));
    for (const spec of Object.values(NODE_TYPES)) {
      if (!spec.palette) continue;
      expect(known.has(spec.palette.category), `${spec.type} → "${spec.palette.category}"`).toBe(
        true
      );
    }
    // Every declared section is actually used (no empty/stale category in the list).
    const used = new Set(
      Object.values(NODE_TYPES)
        .filter((s) => s.palette)
        .map((s) => s.palette!.category)
    );
    for (const c of PALETTE_CATEGORIES) {
      expect(used.has(c.key), `section "${c.key}" has no cards`).toBe(true);
    }
    // The grouped menu covers every palette entry exactly once.
    const inMenu = paletteMenu().flatMap((g) => g.specs.map((s) => s.type));
    const withPalette = Object.values(NODE_TYPES).filter((s) => s.palette).length;
    expect(inMenu.length).toBe(withPalette);
  });

  it("renderAnimNode renders a card for every node type via the registry", () => {
    const make: Record<string, () => GraphNode> = {
      signal: () => signalNode({ id: "s1", name: "kick" }, 0, 0),
      ...Object.fromEntries(paletteSpecs().map((s) => [s.type, () => s.factory!(0, 0)])),
    };
    for (const type of Object.keys(NODE_TYPES)) {
      const node = make[type]();
      const ctx = {
        graph: { nodes: [node], edges: [] },
        signals: [],
        segment: { start: 0, end: 8 },
        onGraphChange: () => {},
      } as unknown as NodeCtx;
      const html = renderToStaticMarkup(renderAnimNode(node, helpers, ctx));
      expect(html, `${type} should render`).toContain('data-port="out"');
    }
  });

  it("normalizeGraph keeps every registry node type (KNOWN_NODE_TYPES covers the registry)", () => {
    // normalizeGraph drops nodes whose type isn't in the hand-maintained
    // KNOWN_NODE_TYPES allowlist. If a card is added to the registry but not that list,
    // adding it silently vanishes (the node is stripped on the next normalize) — so
    // pin every factoried registry type to survive a normalize round-trip.
    for (const spec of paletteSpecs()) {
      const node = spec.factory!(0, 0);
      const g = { ...emptyGraph(), nodes: [node] };
      const out = normalizeGraph(g);
      expect(
        out.nodes.some((n) => n.type === spec.type),
        `${spec.type} is in the registry but dropped by normalizeGraph — add it to KNOWN_NODE_TYPES`
      ).toBe(true);
    }
  });

  it("VIDEO_PRODUCERS matches exactly the registry's video-output cards", () => {
    // Drift guard: an output (and the backend `_VIDEO_HANDLERS`) accepts only these
    // types. If a new video card is added to the registry but not to VIDEO_PRODUCERS
    // (or vice-versa), the app POSTs graphs the backend rejects — so pin them together.
    const fromRegistry = new Set(
      Object.values(NODE_TYPES)
        .filter((s) => s.chrome.outFlow === "video")
        .map((s) => s.type)
    );
    expect(new Set(VIDEO_PRODUCERS)).toEqual(fromRegistry);
  });

  it("chromeFor falls back gracefully for an unknown type", () => {
    expect(chromeFor("fluid").title).toBe("fluid");
    const unknown = chromeFor("totally-new");
    expect(unknown.title).toBe("totally-new");
    expect(unknown.outFlow).toBe("value");
  });
});
