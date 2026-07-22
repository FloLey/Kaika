// Pool-aware hashing mirror (compositions wave, step 02). The frontend key only
// needs to match ITSELF between renders (the backend computes the authoritative
// cache path) — what must mirror the backend is the SENSITIVITY: a referenced
// child's edit changes the key, an unreferenced composition's edit doesn't, and a
// graph with no references keys exactly as before the pool existed.

import { describe, it, expect } from "vitest";
import { outputHash, referencedCompositionIds } from "../lib/graphModel";
import { reachableSlice } from "../lib/compositions";
import type { Composition, CompositionPool, Graph } from "../lib/types";

const backdrop = (color = "#204080"): Graph =>
  ({
    version: 30,
    nodes: [
      { id: "b", type: "backdrop", x: 0, y: 0, data: { color, ports: {} } },
      { id: "o", type: "output", x: 0, y: 0, data: { title: "preview" } },
    ],
    edges: [{ id: "e", source: "b", sourcePort: "out", target: "o", targetPort: "video" }],
  }) as unknown as Graph;

const montage = (...compIds: string[]): Graph =>
  ({
    version: 30,
    nodes: [
      {
        id: "mg",
        type: "montage",
        x: 0,
        y: 0,
        data: {
          extracts: compIds.map((cid, i) => ({ id: `x${i}`, compositionId: cid })),
          manualBreakpoints: [],
          disabledCuts: [],
          threshold: 0.5,
          hysteresis: 0.1,
          ports: {},
        },
      },
      { id: "o", type: "output", x: 0, y: 0, data: { title: "preview" } },
    ],
    edges: [{ id: "e", source: "mg", sourcePort: "out", target: "o", targetPort: "video" }],
  }) as unknown as Graph;

const comp = (id: string, graph: Graph, outputId?: string): Composition => ({
  id,
  name: id,
  graph,
  ...(outputId ? { outputId } : {}),
});

const key = (g: Graph, pool?: CompositionPool) => outputHash(g, "o", "job", 0, 4, [], pool);

describe("outputHash × composition pool", () => {
  it("ignores the pool entirely for a graph with no references", () => {
    const g = backdrop();
    const noise = { c1: comp("c1", backdrop("#ff0000")) };
    expect(key(g)).toBe(key(g, {}));
    expect(key(g)).toBe(key(g, noise));
  });

  it("a referenced child's edit changes the key; an unreferenced one doesn't", () => {
    const g = montage("c1");
    const pool = { c1: comp("c1", backdrop()), cX: comp("cX", backdrop()) };
    const childEdited = { ...pool, c1: comp("c1", backdrop("#3a7f2b")) };
    const strangerEdited = { ...pool, cX: comp("cX", backdrop("#3a7f2b")) };
    expect(key(g, childEdited)).not.toBe(key(g, pool));
    expect(key(g, strangerEdited)).toBe(key(g, pool));
  });

  it("reaches a grandchild (depth 2)", () => {
    const g = montage("c1");
    const pool = { c1: comp("c1", montage("c2")), c2: comp("c2", backdrop()) };
    const edited = { ...pool, c2: comp("c2", backdrop("#3a7f2b")) };
    expect(key(g, edited)).not.toBe(key(g, pool));
  });

  it("a dangling reference still moves the key", () => {
    expect(key(montage("c-gone"), {})).not.toBe(key(montage(), {}));
  });

  it("editing a SHARED child busts every referencing root (the propagation contract)", () => {
    const rootA = montage("shared");
    const rootB = montage("shared");
    const pool = { shared: comp("shared", backdrop()) };
    const edited = { shared: comp("shared", backdrop("#3a7f2b")) };
    expect(key(rootA, edited)).not.toBe(key(rootA, pool));
    expect(key(rootB, edited)).not.toBe(key(rootB, pool));
  });

  it("the child's ★ output mark moves the key", () => {
    const g = montage("c1");
    expect(key(g, { c1: comp("c1", backdrop(), "o") })).not.toBe(
      key(g, { c1: comp("c1", backdrop()) })
    );
  });
});

describe("reachableSlice (what a render POST ships)", () => {
  it("is undefined when the graph references nothing", () => {
    expect(reachableSlice(backdrop(), { c1: comp("c1", backdrop()) })).toBeUndefined();
  });

  it("includes the recursive closure and skips dangling ids", () => {
    const pool = {
      c1: comp("c1", montage("c2", "c-gone")),
      c2: comp("c2", backdrop()),
      cX: comp("cX", backdrop()),
    };
    const slice = reachableSlice(montage("c1"), pool)!;
    expect(Object.keys(slice).sort()).toEqual(["c1", "c2"]);
  });

  it("referencedCompositionIds reads the montage extracts", () => {
    expect([...referencedCompositionIds(montage("a", "b"))].sort()).toEqual(["a", "b"]);
    expect(referencedCompositionIds(backdrop()).size).toBe(0);
  });
});
