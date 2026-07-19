import { describe, it, expect } from "vitest";
import {
  cardInputs,
  sourcesForFlow,
  inputSource,
  partitionSources,
  defaultCardName,
} from "../components/animation/nodeInputs";
import { LOOSE_PORT } from "../lib/graphModel";
import type { Graph, GraphNode } from "../lib/types";

const node = (id: string, type: string, data: Record<string, unknown> = {}): GraphNode =>
  ({ id, type, x: 0, y: 0, data }) as unknown as GraphNode;

const named = (id: string, type: string, name: string): GraphNode =>
  ({ id, type, x: 0, y: 0, name, data: {} }) as unknown as GraphNode;

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

  it("gives montage its params PLUS one video row per slot, with add/remove", () => {
    const m = cardInputs(node("m", "montage", { inputs: [{ id: "s1" }, { id: "s2" }] }));
    const slots = m.inputs.filter((i) => i.kind === "edge");
    expect(slots.map((i) => i.portId)).toEqual(["s1", "s2"]);
    expect(slots.every((i) => i.flow === "video" && i.helpKey === "inputs")).toBe(true);
    // the trigger/opacity params ride along so the settings window edits everything
    expect(m.inputs.some((i) => i.kind === "param" && i.portId === "trigger")).toBe(true);
    expect(m.dynamic?.label).toBe("slot");
  });

  it("has no inputs for pure sources (signal/lfo/noise)", () => {
    expect(cardInputs(node("s", "signal")).inputs).toEqual([]);
    expect(cardInputs(node("l", "lfo")).inputs).toEqual([]);
  });

  it("gives animate-points its points input (was missing)", () => {
    const a = cardInputs(node("a", "animate-points"));
    expect(a.inputs).toEqual([{ portId: "in", flow: "points", label: "points", kind: "edge" }]);
  });

  it("lists only the colour params relevant to the current mode", () => {
    const keys = (mode: string) =>
      cardInputs(node("c", "color", { mode, ports: {} }))
        .inputs.map((i) => i.portId)
        .sort();
    expect(keys("swatch")).toEqual(["intensity", "opacity"]);
    expect(keys("rgb")).toEqual(["b", "g", "intensity", "opacity", "r"]);
    expect(keys("gradient")).toEqual(["intensity", "opacity", "position"]);
  });

  it("tags dynamic rows with a constant helpKey", () => {
    expect(cardInputs(node("m", "math", { inputs: ["p1"] })).inputs[0].helpKey).toBe("input");
    expect(cardInputs(node("c", "combine", { inputs: [{ id: "s1" }] })).inputs[0].helpKey).toBe(
      "layer"
    );
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

describe("defaultCardName", () => {
  it("names by type with the max existing suffix + 1 (survives deletes)", () => {
    const empty = { nodes: [], edges: [] } as unknown as Graph;
    const first = defaultCardName(empty, "fluid"); // "<title> 1"
    const title = first.replace(/ 1$/, "");
    expect(first).toBe(`${title} 1`);

    // "<title> 2" was deleted; next is max(1,3)+1 = 4, NOT count+1.
    const g = {
      nodes: [
        named("a", "fluid", `${title} 1`),
        named("b", "fluid", `${title} 3`),
        node("c", "lfo"),
      ],
      edges: [],
    } as unknown as Graph;
    expect(defaultCardName(g, "fluid")).toBe(`${title} 4`);

    // Ignores other types and unnamed nodes of the same type.
    const g2 = {
      nodes: [node("x", "lfo"), node("y", "fluid")],
      edges: [],
    } as unknown as Graph;
    expect(defaultCardName(g2, "fluid")).toBe(`${title} 1`);
  });
});

describe("inputSource / partitionSources (compact wiring)", () => {
  // A fluid target with `force` bound to lfo "b"; a loose wire parked from lfo "a";
  // lfo "c" is an unconnected candidate. All three are value-flow sources.
  const mk = () => {
    const f = node("f", "fluid", { ports: { force: { binding: { kind: "node", nodeId: "b" } } } });
    const graph = {
      nodes: [f, node("a", "lfo"), node("b", "lfo"), node("c", "lfo")],
      edges: [
        { id: "loose-a", source: "a", sourcePort: "out", target: "f", targetPort: LOOSE_PORT },
        { id: "e-force", source: "b", sourcePort: "out", target: "f", targetPort: "force" },
      ],
    } as unknown as Graph;
    return { graph, f };
  };

  it("inputSource reads a param binding and an edge target", () => {
    const { graph, f } = mk();
    expect(
      inputSource(f, graph, { portId: "force", flow: "value", label: "", kind: "param" })
    ).toBe("b");
    expect(
      inputSource(f, graph, { portId: "positions", flow: "points", label: "", kind: "edge" })
    ).toBeNull();
  });

  it("splits sources into loose / assigned / other, each exactly once", () => {
    const { graph, f } = mk();
    const { loose, assigned, other } = partitionSources(graph, f, "value");
    expect(loose.map((l) => l.srcId)).toEqual(["a"]);
    expect(loose[0].edgeId).toBe("loose-a");
    expect(assigned).toEqual(["b"]);
    expect(other).toEqual(["c"]);
  });

  it("filters each section to the input's flow", () => {
    const { graph, f } = mk();
    // No points-flow sources exist here, so every section is empty for points.
    const p = partitionSources(graph, f, "points");
    expect(p.loose).toEqual([]);
    expect(p.assigned).toEqual([]);
    expect(p.other).toEqual([]);
  });
});
