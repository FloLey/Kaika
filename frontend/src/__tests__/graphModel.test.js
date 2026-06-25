import { describe, it, expect } from "vitest";
import {
  signalNode, constantNode, outputNode, fluidNode, emptyGraph, normalizeGraph,
  connect, disconnect, removeNode, setPortRange, validate, graphHash,
} from "../lib/graphModel.js";
import { FLUID_PARAMS, fluidParam } from "../lib/fluidParams.js";
import { hydrateSegments, serializeSegments, splitAt } from "../lib/segments.js";

const STEMS = { original: { sr: 44100 }, drums: { sr: 44100 } };

// A renderable graph: one fluid wired into one output, plus a constant source.
function wiredGraph() {
  let g = emptyGraph();
  const fluid = fluidNode(0, 0);
  const out = outputNode(0, 0);
  const k = constantNode(0, 0, 0.5);
  g.nodes.push(fluid, out, k);
  // wire fluid -> output (the validate() requirement)
  g.edges.push({ id: "e-out", source: fluid.id, sourcePort: "out", target: out.id, targetPort: "video" });
  return { g, fluidId: fluid.id, outId: out.id, constId: k.id };
}

describe("node factories", () => {
  it("signalNode references the signal id + denormalizes the name", () => {
    const n = signalNode({ id: "sig-1", name: "kick" }, 10, 20);
    expect(n.type).toBe("signal");
    expect(n.id).toMatch(/^n-/);
    expect(n.data).toEqual({ signalId: "sig-1", label: "kick" });
    expect(n.x).toBe(10);
    expect(n.y).toBe(20);
  });

  it("constantNode / outputNode have the right shape", () => {
    expect(constantNode(0, 0).data).toEqual({ value: 0.5, label: "const" });
    expect(constantNode(0, 0, 0.9).data.value).toBe(0.9);
    expect(outputNode(0, 0).data).toEqual({ title: "preview" });
  });

  it("a fresh fluidNode has a const binding per modulatable param", () => {
    const n = fluidNode(0, 0);
    expect(n.type).toBe("fluid");
    for (const p of FLUID_PARAMS) {
      expect(n.data.ports[p.key].binding).toEqual({ kind: "const", value: p.def });
    }
    expect(Object.keys(n.data.ports).length).toBe(FLUID_PARAMS.length);
    expect(n.data.static.grid).toBe(96);
  });

  it("emptyGraph is version 1 with no nodes/edges", () => {
    expect(emptyGraph()).toEqual({ version: 1, nodes: [], edges: [], view: { tx: 0, ty: 0, scale: 1 } });
  });
});

describe("normalizeGraph migrates older saves", () => {
  it("adds missing param ports (e.g. colour) so they become wireable", () => {
    const { g, fluidId, constId } = wiredGraph();
    // Simulate a graph saved before the r/g/b colour ports existed.
    const fluid = g.nodes.find((n) => n.id === fluidId);
    delete fluid.data.ports.r;
    delete fluid.data.ports.g;
    delete fluid.data.ports.b;

    const out = normalizeGraph(g);
    const f = out.nodes.find((n) => n.id === fluidId);
    expect(f.data.ports.r.binding).toEqual({ kind: "const", value: fluidParam("r").def });
    expect(Object.keys(f.data.ports).length).toBe(FLUID_PARAMS.length);

    // The previously-broken path (would throw on undefined port) now works.
    const wired = connect(out, constId, fluidId, "r");
    expect(wired.nodes.find((n) => n.id === fluidId).data.ports.r.binding)
      .toMatchObject({ kind: "node", nodeId: constId });
  });

  it("drops stale ports + dangling edges for removed params", () => {
    const { g, fluidId, constId } = wiredGraph();
    const fluid = g.nodes.find((n) => n.id === fluidId);
    fluid.data.ports.rot_speed = { binding: { kind: "node", nodeId: constId, lo: 0, hi: 1 } };
    g.edges.push({ id: "e-rot", source: constId, sourcePort: "out", target: fluidId, targetPort: "rot_speed" });

    const out = normalizeGraph(g);
    const f = out.nodes.find((n) => n.id === fluidId);
    expect(f.data.ports.rot_speed).toBeUndefined();
    expect(out.edges.find((e) => e.targetPort === "rot_speed")).toBeUndefined();
  });

  it("returns the same object when nothing needs migrating", () => {
    const { g } = wiredGraph();
    expect(normalizeGraph(g)).toBe(g);
  });
});

describe("connect / disconnect keep the binding<->edge invariant", () => {
  it("connect writes the node binding AND an edge; disconnect round-trips to a const with no leftover edge", () => {
    const { g, fluidId, constId } = wiredGraph();
    const p = fluidParam("force");

    const g2 = connect(g, constId, fluidId, "force");
    const fluid2 = g2.nodes.find((n) => n.id === fluidId);
    expect(fluid2.data.ports.force.binding).toEqual({ kind: "node", nodeId: constId, lo: p.min, hi: p.max });
    expect(g2.edges.filter((e) => e.target === fluidId && e.targetPort === "force")).toHaveLength(1);

    const g3 = disconnect(g2, fluidId, "force");
    const fluid3 = g3.nodes.find((n) => n.id === fluidId);
    expect(fluid3.data.ports.force.binding).toEqual({ kind: "const", value: p.def });
    expect(g3.edges.filter((e) => e.target === fluidId && e.targetPort === "force")).toHaveLength(0);
  });

  it("connecting a port twice replaces the prior edge (no duplicates)", () => {
    const { g, fluidId, constId } = wiredGraph();
    const g2 = connect(connect(g, constId, fluidId, "force"), constId, fluidId, "force");
    expect(g2.edges.filter((e) => e.target === fluidId && e.targetPort === "force")).toHaveLength(1);
  });

  it("setPortRange patches lo/hi on a wired port", () => {
    const { g, fluidId, constId } = wiredGraph();
    const g2 = setPortRange(connect(g, constId, fluidId, "force"), fluidId, "force", 0, 45);
    const fluid = g2.nodes.find((n) => n.id === fluidId);
    expect(fluid.data.ports.force.binding).toMatchObject({ kind: "node", lo: 0, hi: 45 });
  });
});

describe("removeNode", () => {
  it("drops the node, its edges, and resets ports bound to it", () => {
    const { g, fluidId, constId } = wiredGraph();
    const g2 = connect(g, constId, fluidId, "force");
    const g3 = removeNode(g2, constId);
    expect(g3.nodes.find((n) => n.id === constId)).toBeUndefined();
    expect(g3.edges.some((e) => e.source === constId || e.target === constId)).toBe(false);
    const fluid = g3.nodes.find((n) => n.id === fluidId);
    expect(fluid.data.ports.force.binding).toEqual({ kind: "const", value: fluidParam("force").def });
  });
});

describe("validate (01 §3.7)", () => {
  it("accepts a fluid wired into exactly one output", () => {
    const { g } = wiredGraph();
    expect(validate(g)).toEqual({ ok: true });
  });

  it("rejects a missing output", () => {
    const { g, outId } = wiredGraph();
    const g2 = { ...g, nodes: g.nodes.filter((n) => n.id !== outId), edges: [] };
    expect(validate(g2).ok).toBe(false);
  });

  it("rejects a binding pointing at a dangling node", () => {
    const { g, fluidId } = wiredGraph();
    const g2 = connect(g, "n-ghost", fluidId, "force");
    const res = validate(g2);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/missing node/);
  });
});

describe("graphHash (01 §3.6)", () => {
  it("is unchanged when only x/y/view change", () => {
    const { g } = wiredGraph();
    const h1 = graphHash(g, "job", 0, 8, []);
    const moved = {
      ...g,
      view: { tx: 999, ty: 999, scale: 3 },
      nodes: g.nodes.map((n) => ({ ...n, x: n.x + 100, y: n.y + 50 })),
    };
    const h2 = graphHash(moved, "job", 0, 8, []);
    expect(h2).toBe(h1);
  });

  it("changes when a referenced signal's defining fields change", () => {
    const sig = { id: "sig-1", stemKey: "drums", minHz: 40, maxHz: 120, feature: "energy", attack: 5, release: 250, invert: false, gamma: 1, gain: 1, offset: 0, threshold: 0 };
    const { g } = wiredGraph();
    g.nodes.push(signalNode(sig, 0, 0));
    const h1 = graphHash(g, "job", 0, 8, [sig]);
    const h2 = graphHash(g, "job", 0, 8, [{ ...sig, gain: 2 }]);
    expect(h2).not.toBe(h1);
  });
});

describe("segments graph persistence + split (01 §3.8)", () => {
  it("round-trips a segment graph and a signalNode's signalId still resolves", () => {
    const seg0 = hydrateSegments(
      [{ start: 0, end: 10, label: "verse", signals: [{ name: "kick", stemKey: "drums", feature: "energy" }] }],
      STEMS
    )[0];
    const sigId = seg0.signals[0].id;
    // attach a graph that references the signal
    seg0.graph = { ...emptyGraph(), nodes: [signalNode(seg0.signals[0], 0, 0)] };

    const round = hydrateSegments(serializeSegments([seg0]), STEMS)[0];
    expect(round.graph).toEqual(seg0.graph);
    // the stored signal id survived hydrate, so the graph ref still resolves.
    expect(round.signals.some((s) => s.id === sigId)).toBe(true);
    expect(round.graph.nodes[0].data.signalId).toBe(sigId);
    expect(round.signals.some((s) => s.id === round.graph.nodes[0].data.signalId)).toBe(true);
  });

  it("splitAt gives the cloned half fresh ids + remaps its graph, with distinct graph objects", () => {
    const seg = hydrateSegments(
      [{ start: 0, end: 10, label: "verse", signals: [{ name: "kick", stemKey: "drums", feature: "energy" }] }],
      STEMS
    )[0];
    seg.graph = { ...emptyGraph(), nodes: [signalNode(seg.signals[0], 0, 0)] };

    const [a, b] = splitAt([seg], 5);
    // two halves do not share a graph object
    expect(a.graph).not.toBe(b.graph);
    // first half keeps its original signal id + a valid ref
    expect(a.graph.nodes[0].data.signalId).toBe(seg.signals[0].id);
    expect(a.signals.some((s) => s.id === a.graph.nodes[0].data.signalId)).toBe(true);
    // second half got fresh signal ids AND a remapped graph (no dangling ref)
    const bRef = b.graph.nodes[0].data.signalId;
    expect(bRef).not.toBe(seg.signals[0].id);
    expect(b.signals.some((s) => s.id === bRef)).toBe(true);
  });
});
