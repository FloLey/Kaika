import { describe, it, expect } from "vitest";
import { planDrop, dropCandidates } from "../components/animation/dropPlan";
import {
  combineNode,
  connectVideo,
  fluidNode,
  gateNode,
  lfoNode,
  lyricsNode,
  colorNode,
  outputNode,
  wirePort,
  isLooseEdge,
  connectLoose,
} from "../lib/graphModel";
import type { Graph, GraphNode } from "../lib/types";

// What a wire dropped on a compact card resolves to. The editor used to park EVERY
// such drop as a gray loose wire (every card but `output` is compact), so the canvas
// could no longer wire anything; these are the rules that give the gesture back.

const g = (nodes: GraphNode[], edges: Graph["edges"] = []): Graph => ({
  version: 1,
  nodes,
  edges,
});

describe("planDrop", () => {
  it("wires straight into a card whose only legal input is free", () => {
    // The case the old auto-assign missed entirely: a gate's `in` is a plain edge,
    // not a modulatable port, so resolveDropPort declined and the wire parked.
    const lfo = lfoNode(0, 0);
    const gate = gateNode(200, 0);
    const plan = planDrop(g([lfo, gate]), "value", gate.id);
    expect(plan).toEqual({ kind: "connect", portId: "in" });
  });

  it("wires video into an empty output without asking", () => {
    const fluid = fluidNode(0, 0);
    const out = outputNode(200, 0);
    expect(planDrop(g([fluid, out]), "video", out.id)).toEqual({
      kind: "connect",
      portId: "video",
    });
  });

  it("takes a combine's first FREE layer, then offers the menu once they are full", () => {
    const a = fluidNode(0, 0);
    const b = fluidNode(0, 100);
    const comb = combineNode(200, 0);
    const slots = comb.data.inputs.map((s) => s.id);

    const empty = g([a, b, comb]);
    expect(planDrop(empty, "video", comb.id)).toEqual({ kind: "connect", portId: slots[0] });

    // Fill every slot: now no slot is free, so the drop must ask rather than guess.
    let full: Graph = empty;
    for (const s of slots) full = connectVideo(full, a.id, "out", comb.id, s);
    const plan = planDrop(full, "video", comb.id);
    expect(plan.kind).toBe("menu");
    if (plan.kind !== "menu") throw new Error("unreachable");
    expect(plan.candidates.map((c) => c.portId)).toEqual(slots);
    expect(plan.candidates.every((c) => c.currentSource === a.id)).toBe(true);
    // …and offers to grow the group rather than making "full" a dead end.
    expect(plan.dynamic?.label).toBe("layer");
  });

  it("opens the menu for a fresh fluid — twenty const params is exactly the ambiguity", () => {
    const lfo = lfoNode(0, 0);
    const fluid = fluidNode(200, 0);
    const plan = planDrop(g([lfo, fluid]), "value", fluid.id);
    expect(plan.kind).toBe("menu");
    if (plan.kind !== "menu") throw new Error("unreachable");
    expect(plan.candidates.length).toBeGreaterThan(1);
    expect(plan.candidates.every((c) => c.currentSource === null)).toBe(true);
    expect(plan.dynamic).toBeUndefined(); // a fluid's ports are fixed
  });

  it("a lone but OCCUPIED input still asks — a silent replace is not a gesture", () => {
    const lfo = lfoNode(0, 0);
    const other = lfoNode(0, 100);
    const gate = gateNode(200, 0);
    const wired = wirePort(g([lfo, other, gate]), other.id, "out", gate.id, "in");
    const plan = planDrop(wired, "value", gate.id);
    expect(plan.kind).toBe("menu");
    if (plan.kind !== "menu") throw new Error("unreachable");
    expect(plan.candidates).toEqual([
      { portId: "in", label: "input", group: undefined, currentSource: other.id },
    ]);
  });

  it("parks when the card cannot take the flow at all", () => {
    // A video wire onto an lfo: nothing there could ever accept it, so the parked
    // gray wire remains the honest outcome.
    const fluid = fluidNode(0, 0);
    const lfo = lfoNode(200, 0);
    expect(planDrop(g([fluid, lfo]), "video", lfo.id)).toEqual({ kind: "park" });
  });

  it("parks on a missing target rather than throwing", () => {
    expect(planDrop(g([]), "value", "gone")).toEqual({ kind: "park" });
  });

  it("colour into lyrics: one free of two resolves, both free asks", () => {
    const col = colorNode(0, 0);
    const col2 = colorNode(0, 100);
    const lyr = lyricsNode(200, 0);
    // Both free → the existing heuristic declines (it only auto-picks a lone free
    // one), so the user chooses fill vs outline.
    const both = planDrop(g([col, col2, lyr]), "color", lyr.id);
    expect(both.kind).toBe("menu");
    // Fill taken → outline is the only free one left, and lands without a menu.
    const oneTaken = connectVideo(g([col, col2, lyr]), col.id, "out", lyr.id, "fillColor");
    expect(planDrop(oneTaken, "color", lyr.id)).toEqual({
      kind: "connect",
      portId: "outlineColor",
    });
  });
});

describe("dropCandidates", () => {
  it("lists only the inputs of the dropped flow, carrying the fluid param groups", () => {
    const fluid = fluidNode(0, 0);
    const graph = g([fluid]);
    const values = dropCandidates(graph, fluid, "value");
    const points = dropCandidates(graph, fluid, "points");
    expect(points.map((c) => c.portId)).toEqual(["positions"]);
    expect(values.some((c) => c.portId === "positions")).toBe(false);
    expect(values.some((c) => !!c.group)).toBe(true); // source/medium headers
  });
});

describe("wirePort", () => {
  it("writes BOTH the binding and the edge for a modulatable param", () => {
    const lfo = lfoNode(0, 0);
    const fluid = fluidNode(200, 0);
    const out = wirePort(g([lfo, fluid]), lfo.id, "out", fluid.id, "force");
    const node = out.nodes.find((n) => n.id === fluid.id) as GraphNode;
    const binding = (node.data as { ports: Record<string, { binding?: { nodeId?: string } }> })
      .ports.force.binding;
    expect(binding).toMatchObject({ kind: "node", nodeId: lfo.id });
    expect(out.edges.filter((e) => e.target === fluid.id && e.targetPort === "force")).toHaveLength(
      1
    );
  });

  it("consumes a wire the same source had PARKED on the card", () => {
    // Otherwise assigning a parked wire from the canvas would leave the gray dash
    // behind next to the real teal edge.
    const lfo = lfoNode(0, 0);
    const fluid = fluidNode(200, 0);
    const parked = connectLoose(g([lfo, fluid]), lfo.id, fluid.id);
    expect(parked.edges.filter(isLooseEdge)).toHaveLength(1);
    const out = wirePort(parked, lfo.id, "out", fluid.id, "force");
    expect(out.edges.filter(isLooseEdge)).toHaveLength(0);
    expect(out.edges).toHaveLength(1);
  });
});
