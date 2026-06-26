import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import renderAnimNode from "../components/animation/renderAnimNode";
import { NODE_TYPES, paletteSpecs, chromeFor } from "../components/animation/nodes/registry";
import { signalNode } from "../lib/graphModel";
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
      expect(spec.chrome.outFlow).toMatch(/^(value|video|points)$/);
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

  it("chromeFor falls back gracefully for an unknown type", () => {
    expect(chromeFor("fluid").title).toBe("fluid");
    const unknown = chromeFor("totally-new");
    expect(unknown.title).toBe("totally-new");
    expect(unknown.outFlow).toBe("value");
  });
});
