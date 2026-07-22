// The pool's lifecycle rules (specs/compositions step 07): cycle refusal at the
// source, reference counting, and the orphan prune — remove a reference and the
// composition survives while ANY other reference reaches it; only the last one
// going away orphans it.

import { describe, it, expect } from "vitest";
import { pruneOrphans, refCounts, wouldCycle } from "../lib/compositions";
import { addExtract, emptyGraph, montageNode } from "../lib/graphModel";
import type { Composition, CompositionPool, Graph } from "../lib/types";

const plain = (): Graph => ({ ...emptyGraph(), nodes: [], edges: [] });

function montageComp(id: string, ...childIds: string[]): Composition {
  const mg = montageNode(0, 0);
  let g: Graph = { ...emptyGraph(), nodes: [mg] };
  for (const cid of childIds) g = addExtract(g, mg.id, cid);
  return { id, name: id, graph: g };
}
const leafish = (id: string): Composition => ({ id, name: id, graph: plain() });

describe("wouldCycle", () => {
  const pool: CompositionPool = {
    root: montageComp("root", "mid"),
    mid: montageComp("mid", "leaf"),
    leaf: leafish("leaf"),
    other: leafish("other"),
  };

  it("refuses self and any ancestor, at any depth", () => {
    expect(wouldCycle(pool, "root", "root")).toBe(true); // self
    expect(wouldCycle(pool, "mid", "root")).toBe(true); // root reaches mid
    expect(wouldCycle(pool, "leaf", "root")).toBe(true); // transitively
    expect(wouldCycle(pool, "leaf", "mid")).toBe(true);
  });

  it("allows siblings, descendants and strangers", () => {
    expect(wouldCycle(pool, "root", "mid")).toBe(false); // already the child — fine
    expect(wouldCycle(pool, "root", "leaf")).toBe(false);
    expect(wouldCycle(pool, "root", "other")).toBe(false);
    expect(wouldCycle(pool, "mid", "other")).toBe(false);
  });
});

describe("refCounts", () => {
  it("counts segment roots and every extract reference, nested included", () => {
    const pool: CompositionPool = {
      root: montageComp("root", "shared", "shared"), // referenced twice by one montage
      mid: montageComp("mid", "shared"),
      shared: leafish("shared"),
    };
    const segs = [{ rootCompositionId: "root" }, { rootCompositionId: "mid" }];
    const counts = refCounts(pool, segs);
    expect(counts.root).toBe(1);
    expect(counts.mid).toBe(1);
    expect(counts.shared).toBe(3); // two extracts in root + one in mid
  });
});

describe("pruneOrphans", () => {
  it("drops whole unreachable chains, keeps everything a root reaches", () => {
    const pool: CompositionPool = {
      root: montageComp("root", "kept"),
      kept: leafish("kept"),
      orphan: montageComp("orphan", "orphanChild"), // nothing references it…
      orphanChild: leafish("orphanChild"), // …so its child goes too
    };
    const out = pruneOrphans(pool, [{ rootCompositionId: "root" }]);
    expect(Object.keys(out).sort()).toEqual(["kept", "root"]);
  });

  it("a composition survives while ANY reference reaches it", () => {
    const pool: CompositionPool = {
      a: montageComp("a", "shared"),
      b: montageComp("b", "shared"),
      shared: leafish("shared"),
    };
    // b's segment is gone — shared still reachable through a.
    const out = pruneOrphans(pool, [{ rootCompositionId: "a" }]);
    expect(Object.keys(out).sort()).toEqual(["a", "shared"]);
  });

  it("returns the SAME object when nothing is orphaned (identity gates saves)", () => {
    const pool: CompositionPool = { root: montageComp("root", "kept"), kept: leafish("kept") };
    expect(pruneOrphans(pool, [{ rootCompositionId: "root" }])).toBe(pool);
  });
});
