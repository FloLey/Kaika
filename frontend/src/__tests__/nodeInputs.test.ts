import { describe, it, expect } from "vitest";
import { cardInputs, sourcesForFlow } from "../components/animation/nodeInputs";
import type { Graph, GraphNode } from "../lib/types";

const node = (id: string, type: string, data: Record<string, unknown> = {}): GraphNode =>
  ({ id, type, x: 0, y: 0, data }) as unknown as GraphNode;

describe("cardInputs", () => {
  it("gives a single value edge input for gate/shaper/scope", () => {
    const gate = cardInputs(node("g", "gate"));
    expect(gate.inputs).toEqual([{ portId: "in", flow: "value", label: "input", kind: "edge" }]);
    expect(gate.dynamic).toBeUndefined();
  });

  it("lists math's dynamic value inputs from data.inputs, with add/remove", () => {
    const m = cardInputs(node("m", "math", { inputs: ["p1", "p2"] }));
    expect(m.inputs.map((i) => i.portId)).toEqual(["p1", "p2"]);
    expect(m.inputs.every((i) => i.flow === "value" && i.kind === "edge")).toBe(true);
    expect(m.dynamic?.label).toBe("input");
    expect(typeof m.dynamic?.add).toBe("function");
  });

  it("gives fluid its params plus positions(points) and colour(color) edges", () => {
    const f = cardInputs(node("f", "fluid", { ports: {} }));
    const byId = Object.fromEntries(f.inputs.map((i) => [i.portId, i]));
    expect(byId.positions).toMatchObject({ flow: "points", kind: "edge" });
    expect(byId.color).toMatchObject({ flow: "color", kind: "edge" });
    // fluid params (from nodeParams) are present as kind "param"
    expect(f.inputs.some((i) => i.kind === "param")).toBe(true);
  });

  it("gives combine its video-layer inputs with add/remove", () => {
    const c = cardInputs(node("c", "combine", { inputs: [{ id: "s1" }, { id: "s2" }] }));
    expect(c.inputs.map((i) => i.portId)).toEqual(["s1", "s2"]);
    expect(c.inputs.every((i) => i.flow === "video")).toBe(true);
    expect(c.dynamic?.label).toBe("layer");
  });

  it("has no inputs for pure sources (signal/lfo/noise)", () => {
    expect(cardInputs(node("s", "signal")).inputs).toEqual([]);
    expect(cardInputs(node("l", "lfo")).inputs).toEqual([]);
  });
});

describe("sourcesForFlow", () => {
  const graph = {
    nodes: [
      node("sig", "signal"),
      node("lfo", "lfo"),
      node("pts", "points"),
      node("fl", "fluid"),
      node("me", "gate"),
    ],
    edges: [],
  } as unknown as Graph;

  it("returns nodes whose output flow matches, excluding self", () => {
    const value = sourcesForFlow(graph, "value", "me").map((n) => n.id);
    expect(value.sort()).toEqual(["lfo", "sig"]); // gate 'me' excluded
    expect(sourcesForFlow(graph, "points", "x").map((n) => n.id)).toEqual(["pts"]);
    expect(sourcesForFlow(graph, "video", "x").map((n) => n.id)).toEqual(["fl"]);
  });
});
