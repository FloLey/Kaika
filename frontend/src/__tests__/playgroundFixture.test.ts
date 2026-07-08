import { describe, it, expect } from "vitest";
import fixture from "../../../backend/playground_pipelines.json";
import { normalizeGraph } from "../lib/graphModel";
import { estimateCardSize } from "../lib/graph/layout";
import type { Graph } from "../lib/types";

// `tests/test_card_impact.py` guards the Playground on the BACKEND — it renders each
// pipeline, which never runs `normalizeGraph`. So a pipeline could render correctly and
// still lose its card the moment the UI loads it (a stale `version` stamp sends the graph
// back through a legacy migration: pre-v8 renames `color`→`grade` and drops it; pre-v15
// renames `imagegen`→`slideshow`; pre-v10 drops `transform`). That's invisible to pytest.
//
// This is the frontend half of the invariant: every Playground pipeline must still
// contain the card it demonstrates AFTER migration.
interface Demo {
  key: string;
  label: string;
  graph: Graph;
}

const DEMOS = fixture as unknown as Demo[];

describe("playground_pipelines.json survives normalizeGraph", () => {
  it("has a pipeline per demo with a graph", () => {
    expect(DEMOS.length).toBeGreaterThan(0);
    for (const d of DEMOS) expect(d.graph?.nodes).toBeTruthy();
  });

  it("every pipeline still contains the card it demonstrates after migration", () => {
    const lost = DEMOS.filter(
      (d) => !normalizeGraph(d.graph).nodes.some((n) => n.type === d.key)
    ).map((d) => `${d.label} (graph v${d.graph.version}) loses its '${d.key}' card`);
    expect(lost).toEqual([]);
  });

  it("no pipeline loses nodes or edges to the unknown-type filter", () => {
    for (const d of DEMOS) {
      const norm = normalizeGraph(d.graph);
      expect(norm.nodes.length, `${d.label} dropped a node`).toBe(d.graph.nodes.length);
      expect(norm.edges.length, `${d.label} dropped an edge`).toBe(d.graph.edges.length);
    }
  });
});

// The Playground is the first thing a newcomer opens, so a demo must not greet them with
// cards stacked on top of each other. The fixture is laid out with the app's own
// `flowLayout`; this pins the result using the SAME box model, so the guard and the
// layout can never disagree about how big a card is.
describe("playground_pipelines.json is cleanly arranged", () => {
  const boxesOf = (d: Demo) =>
    d.graph.nodes.map((n) => ({
      id: n.id,
      x: n.x,
      y: n.y,
      ...estimateCardSize(n.type, "detailed"),
    }));

  it("no two cards overlap in any pipeline", () => {
    const clashes: string[] = [];
    for (const d of DEMOS) {
      const boxes = boxesOf(d);
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i];
          const b = boxes[j];
          if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
            clashes.push(`${d.label}: ${a.id} overlaps ${b.id}`);
          }
        }
      }
    }
    expect(clashes).toEqual([]);
  });

  it("every card sits at a positive, whole-pixel coordinate", () => {
    const bad: string[] = [];
    for (const d of DEMOS) {
      for (const n of d.graph.nodes) {
        if (!Number.isInteger(n.x) || !Number.isInteger(n.y)) bad.push(`${d.label}/${n.id} fractional`);
        if (n.x < 0 || n.y < 0) bad.push(`${d.label}/${n.id} negative (${n.x},${n.y})`);
      }
    }
    expect(bad).toEqual([]);
  });
});
