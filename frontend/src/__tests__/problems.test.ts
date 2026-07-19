import { describe, it, expect } from "vitest";
import { problemsFor } from "../lib/graph/problems";
import { gateNode, fluidNode, outputNode } from "../lib/graphModel";
import type { Graph, GraphNode, Signal } from "../lib/types";

// The ⚠ problems chip: each rule mirrors a real "renders silently wrong" session.

const sig = (id: string): Signal => ({
  id,
  stemKey: "drums",
  minHz: 20,
  maxHz: 200,
  feature: "energy",
  attack: 5,
  release: 250,
  invert: false,
  gamma: 1,
  gain: 1,
  offset: 0,
  threshold: 0,
});

const g = (nodes: GraphNode[], edges: Graph["edges"] = []): Graph => ({
  version: 1,
  nodes,
  edges,
});

describe("problemsFor", () => {
  it("flags an input-resolving value card with nothing wired in", () => {
    const gate = gateNode(0, 0);
    const probs = problemsFor(g([gate]));
    expect(probs).toHaveLength(1);
    expect(probs[0]).toMatchObject({ nodeId: gate.id });
    expect(probs[0].message).toContain("no input");
  });

  it("a wired gate is fine; a loose (parked) wire doesn't count as an input", () => {
    const gate = gateNode(0, 0);
    const lfo: GraphNode = {
      id: "l1",
      type: "lfo",
      x: 0,
      y: 0,
      data: { shape: "sine", rateMode: "cycles", rate: 4, phase: 0, duty: 0.5 },
    };
    const wired = g(
      [gate, lfo],
      [{ id: "e1", source: "l1", sourcePort: "out", target: gate.id, targetPort: "in" }]
    );
    expect(problemsFor(wired)).toHaveLength(0);
    const loose = g(
      [gate, lfo],
      [{ id: "e1", source: "l1", sourcePort: "out", target: gate.id, targetPort: "__in" }]
    );
    expect(problemsFor(loose)).toHaveLength(1); // parked wire feeds nothing
  });

  it("flags a zero-width lo–hi binding (the flattened-signal bug)", () => {
    const fluid = fluidNode(0, 0);
    fluid.data.ports.force.binding = { kind: "node", nodeId: "l1", lo: 0, hi: 0 };
    const lfo: GraphNode = {
      id: "l1",
      type: "lfo",
      x: 0,
      y: 0,
      data: { shape: "sine", rateMode: "cycles", rate: 4, phase: 0, duty: 0.5 },
    };
    const probs = problemsFor(
      g(
        [fluid, lfo],
        [{ id: "e1", source: "l1", sourcePort: "out", target: fluid.id, targetPort: "force" }]
      )
    );
    expect(probs).toHaveLength(1);
    expect(probs[0].message).toContain("flattened");
  });

  it("flags an output with no video input", () => {
    const out = outputNode(0, 0);
    const probs = problemsFor(g([out]));
    expect(probs.some((p) => p.nodeId === out.id && p.message.includes("no input"))).toBe(true);
  });

  it("flags a signal card whose segment signal was deleted", () => {
    const sn: GraphNode = { id: "s1", type: "signal", x: 0, y: 0, data: { signalId: "sig-gone" } };
    expect(problemsFor(g([sn]), { signals: [sig("sig-other")] })).toHaveLength(1);
    expect(problemsFor(g([sn]), { signals: [sig("sig-gone")] })).toHaveLength(0);
  });

  it("flags a stale ★ final-output mark", () => {
    const fluid = fluidNode(0, 0);
    const out = outputNode(0, 0);
    const wired = g(
      [fluid, out],
      [{ id: "e1", source: fluid.id, sourcePort: "out", target: out.id, targetPort: "video" }]
    );
    expect(problemsFor(wired, { signals: [], finalOutputId: out.id })).toHaveLength(0);
    const probs = problemsFor(wired, { signals: [], finalOutputId: "n-deleted" });
    expect(probs).toHaveLength(1);
    expect(probs[0].message).toContain("final-output");
  });

  it("a healthy pipeline reports nothing", () => {
    const fluid = fluidNode(0, 0);
    const out = outputNode(0, 0);
    const wired = g(
      [fluid, out],
      [{ id: "e1", source: fluid.id, sourcePort: "out", target: out.id, targetPort: "video" }]
    );
    expect(problemsFor(wired, { signals: [] })).toEqual([]);
  });
});
