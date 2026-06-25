import { describe, it, expect } from "vitest";
import {
  signalNode, outputNode, fluidNode, emptyGraph, normalizeGraph, GRAPH_VERSION,
  connect, disconnect, removeNode, validate,
  outputHash, videoInput,
  combineNode, connectVideo, videoSource, outputRenderable,
  addCombineInput, removeCombineInput, setCombineMode, setCombineOpacity, setCombineMedium,
  pointsNode, addPoint, movePoint, removePoint,
} from "../lib/graphModel";
import { FLUID_PARAMS, fluidParam } from "../lib/fluidParams.js";
import { hydrateSegments, serializeSegments, splitAt } from "../lib/segments.js";

const STEMS = { original: { sr: 44100 }, drums: { sr: 44100 } };

// A renderable graph: one fluid wired into one output, plus a signal value source.
function wiredGraph() {
  let g = emptyGraph();
  const fluid = fluidNode(0, 0);
  const out = outputNode(0, 0);
  const src = signalNode({ id: "sig-src", name: "src" }, 0, 0);
  g.nodes.push(fluid, out, src);
  // wire fluid -> output (the validate() requirement)
  g.edges.push({ id: "e-out", source: fluid.id, sourcePort: "out", target: out.id, targetPort: "video" });
  return { g, fluidId: fluid.id, outId: out.id, srcId: src.id };
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

  it("outputNode has the right shape", () => {
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

  it("emptyGraph is the current GRAPH_VERSION with no nodes/edges", () => {
    expect(emptyGraph()).toEqual({ version: GRAPH_VERSION, nodes: [], edges: [], view: { tx: 0, ty: 0, scale: 1 } });
  });
});

describe("normalizeGraph migrates older saves", () => {
  it("adds missing param ports (e.g. colour) so they become wireable", () => {
    const { g, fluidId, srcId } = wiredGraph();
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
    const wired = connect(out, srcId, fluidId, "r");
    expect(wired.nodes.find((n) => n.id === fluidId).data.ports.r.binding)
      .toMatchObject({ kind: "node", nodeId: srcId });
  });

  it("drops stale ports + dangling edges for removed params", () => {
    const { g, fluidId, srcId } = wiredGraph();
    const fluid = g.nodes.find((n) => n.id === fluidId);
    fluid.data.ports.rot_speed = { binding: { kind: "node", nodeId: srcId, lo: 0, hi: 1 } };
    g.edges.push({ id: "e-rot", source: srcId, sourcePort: "out", target: fluidId, targetPort: "rot_speed" });

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
    const { g, fluidId, srcId } = wiredGraph();
    const p = fluidParam("force");

    const g2 = connect(g, srcId, fluidId, "force");
    const fluid2 = g2.nodes.find((n) => n.id === fluidId);
    expect(fluid2.data.ports.force.binding).toEqual({ kind: "node", nodeId: srcId, lo: p.min, hi: p.max });
    expect(g2.edges.filter((e) => e.target === fluidId && e.targetPort === "force")).toHaveLength(1);

    const g3 = disconnect(g2, fluidId, "force");
    const fluid3 = g3.nodes.find((n) => n.id === fluidId);
    expect(fluid3.data.ports.force.binding).toEqual({ kind: "const", value: p.def });
    expect(g3.edges.filter((e) => e.target === fluidId && e.targetPort === "force")).toHaveLength(0);
  });

  it("connecting a port twice replaces the prior edge (no duplicates)", () => {
    const { g, fluidId, srcId } = wiredGraph();
    const g2 = connect(connect(g, srcId, fluidId, "force"), srcId, fluidId, "force");
    expect(g2.edges.filter((e) => e.target === fluidId && e.targetPort === "force")).toHaveLength(1);
  });

  // (port lo/hi patching is covered by the fluidBindings setNodeRange test.)
});

describe("removeNode", () => {
  it("drops the node, its edges, and resets ports bound to it", () => {
    const { g, fluidId, srcId } = wiredGraph();
    const g2 = connect(g, srcId, fluidId, "force");
    const g3 = removeNode(g2, srcId);
    expect(g3.nodes.find((n) => n.id === srcId)).toBeUndefined();
    expect(g3.edges.some((e) => e.source === srcId || e.target === srcId)).toBe(false);
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

  it("rejects a non-numeric const binding (malformed graph)", () => {
    const { g, fluidId } = wiredGraph();
    const g2 = {
      ...g,
      nodes: g.nodes.map((n) =>
        n.id === fluidId
          ? { ...n, data: { ...n.data, ports: { ...n.data.ports, force: { binding: { kind: "const", value: "loud" } } } } }
          : n),
    };
    expect(validate(g2).ok).toBe(false);
  });
});

// Two independent fluid -> output pipelines in one graph.
function twoPipelines() {
  let g = emptyGraph();
  const fA = fluidNode(0, 0);
  const oA = outputNode(0, 0);
  const fB = fluidNode(0, 0);
  const oB = outputNode(0, 0);
  g.nodes.push(fA, oA, fB, oB);
  g.edges.push(
    { id: "eA", source: fA.id, sourcePort: "out", target: oA.id, targetPort: "video" },
    { id: "eB", source: fB.id, sourcePort: "out", target: oB.id, targetPort: "video" },
  );
  return { g, fA: fA.id, oA: oA.id, fB: fB.id, oB: oB.id };
}

// Set a fluid node's const param value (returns a new graph).
const setForce = (g, fluidId, value) => ({
  ...g,
  nodes: g.nodes.map((n) =>
    n.id === fluidId
      ? { ...n, data: { ...n.data, ports: { ...n.data.ports, force: { binding: { kind: "const", value } } } } }
      : n),
});

describe("multiple fluid -> output pipelines", () => {
  it("validate accepts two independent pipelines", () => {
    expect(validate(twoPipelines().g)).toEqual({ ok: true });
  });

  it("videoInput resolves each output's own fluid", () => {
    const { g, fA, oA, fB, oB } = twoPipelines();
    expect(videoInput(g, oA).id).toBe(fA);
    expect(videoInput(g, oB).id).toBe(fB);
  });

  it("outputHash differs per output and isolates edits to one pipeline", () => {
    const { g, oA, fB, oB } = twoPipelines();
    const hA = outputHash(g, oA, "job", 0, 8, []);
    const hB = outputHash(g, oB, "job", 0, 8, []);
    expect(hA).not.toBe(hB);
    // edit fluid B's force: B's hash changes, A's is untouched.
    const g2 = setForce(g, fB, 42);
    expect(outputHash(g2, oA, "job", 0, 8, [])).toBe(hA);
    expect(outputHash(g2, oB, "job", 0, 8, [])).not.toBe(hB);
  });

  it("outputHash ignores node position", () => {
    const { g, oA } = twoPipelines();
    const h1 = outputHash(g, oA, "job", 0, 8, []);
    const moved = { ...g, nodes: g.nodes.map((n) => ({ ...n, x: n.x + 100, y: n.y + 9 })) };
    expect(outputHash(moved, oA, "job", 0, 8, [])).toBe(h1);
  });
});

describe("outputHash signal + orphan semantics (01 §3.6)", () => {
  it("changes when a referenced signal's defining fields change", () => {
    const sig = { id: "sig-1", stemKey: "drums", minHz: 40, maxHz: 120, feature: "energy", attack: 5, release: 250, invert: false, gamma: 1, gain: 1, offset: 0, threshold: 0 };
    const { g, fluidId, outId } = wiredGraph();
    const sigNode = signalNode(sig, 0, 0);
    g.nodes.push(sigNode);
    // wire it into the fluid so it actually contributes to the render
    const wired = connect(g, sigNode.id, fluidId, "force");
    const h1 = outputHash(wired, outId, "job", 0, 8, [sig]);
    const h2 = outputHash(wired, outId, "job", 0, 8, [{ ...sig, gain: 2 }]);
    expect(h2).not.toBe(h1);
  });

  it("is unchanged when a disconnected node is added (orphans don't recompute)", () => {
    const { g, outId } = wiredGraph();
    const h1 = outputHash(g, outId, "job", 0, 8, []);
    const withOrphan = {
      ...g,
      nodes: [...g.nodes, signalNode({ id: "sig-orphan", name: "orphan" }, 0, 0)],
    };
    const h2 = outputHash(withOrphan, outId, "job", 0, 8, []);
    expect(h2).toBe(h1);
  });

  it("changes once a previously-disconnected node is wired into the output", () => {
    const { g, fluidId, outId } = wiredGraph();
    const sigNode = signalNode({ id: "sig-1", name: "kick" }, 0, 0);
    const withOrphan = { ...g, nodes: [...g.nodes, sigNode] };
    const h1 = outputHash(withOrphan, outId, "job", 0, 8, []);
    const wired = connect(withOrphan, sigNode.id, fluidId, "force");
    const h2 = outputHash(wired, outId, "job", 0, 8, []);
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

describe("combine nodes (spec 10)", () => {
  // fluidA + fluidB -> combine -> output
  function pipeline() {
    let g = emptyGraph();
    const a = fluidNode(0, 0), b = fluidNode(100, 0), cb = combineNode(50, 50), out = outputNode(200, 0);
    g = { ...g, nodes: [a, b, cb, out] };
    g = connectVideo(g, a.id, "out", cb.id, cb.data.inputs[0].id);
    g = connectVideo(g, b.id, "out", cb.id, cb.data.inputs[1].id);
    g = connectVideo(g, cb.id, "out", out.id, "video");
    return { g, a, b, cb, out };
  }

  it("combineNode factory: merge mode, two slots, medium", () => {
    const cb = combineNode(0, 0);
    expect(cb.type).toBe("combine");
    expect(cb.data.mode).toBe("merge");
    expect(cb.data.inputs).toHaveLength(2);
    expect(cb.data.medium.vorticity).toBeDefined();
  });

  it("connectVideo wires producers into combine slots + output; validate passes", () => {
    const { g, a, cb } = pipeline();
    expect(videoSource(g, cb.id, cb.data.inputs[0].id)).toBe(a.id);
    expect(validate(g).ok).toBe(true);
    expect(outputRenderable(g, g.nodes[3].id)).toBe(true);
  });

  it("a stack combine feeding a merge combine is rejected", () => {
    let g = emptyGraph();
    const f = fluidNode(0, 0), stack = combineNode(0, 0), merge = combineNode(0, 0), out = outputNode(0, 0);
    g = { ...g, nodes: [f, stack, merge, out] };
    g = setCombineMode(g, stack.id, "stack");
    g = connectVideo(g, f.id, "out", stack.id, stack.data.inputs[0].id);
    g = connectVideo(g, stack.id, "out", merge.id, merge.data.inputs[0].id);
    g = connectVideo(g, merge.id, "out", out.id, "video");
    expect(validate(g).ok).toBe(false);
  });

  it("output passthrough: fluid -> output -> combine -> output2 validates + renderable", () => {
    let g = emptyGraph();
    const f = fluidNode(0, 0), o1 = outputNode(0, 0), cb = combineNode(0, 0), o2 = outputNode(0, 0);
    g = { ...g, nodes: [f, o1, cb, o2] };
    g = connectVideo(g, f.id, "out", o1.id, "video");
    g = connectVideo(g, o1.id, "video", cb.id, cb.data.inputs[0].id);
    g = connectVideo(g, cb.id, "out", o2.id, "video");
    expect(validate(g).ok).toBe(true);
    expect(outputRenderable(g, o2.id)).toBe(true);
  });

  it("outputRenderable false when a combine has no wired input", () => {
    let g = emptyGraph();
    const cb = combineNode(0, 0), out = outputNode(0, 0);
    g = { ...g, nodes: [cb, out] };
    g = connectVideo(g, cb.id, "out", out.id, "video");
    expect(outputRenderable(g, out.id)).toBe(false);
  });

  it("outputHash isolates pipelines: editing combine B doesn't change output A's hash", () => {
    let g = emptyGraph();
    const fa = fluidNode(0, 0), ca = combineNode(0, 0), oa = outputNode(0, 0);
    const fb = fluidNode(0, 0), cb = combineNode(0, 0), ob = outputNode(0, 0);
    g = { ...g, nodes: [fa, ca, oa, fb, cb, ob] };
    g = connectVideo(g, fa.id, "out", ca.id, ca.data.inputs[0].id);
    g = connectVideo(g, ca.id, "out", oa.id, "video");
    g = connectVideo(g, fb.id, "out", cb.id, cb.data.inputs[0].id);
    g = connectVideo(g, cb.id, "out", ob.id, "video");
    const hA = outputHash(g, oa.id, "job", 0, 10, []);
    const hB = outputHash(g, ob.id, "job", 0, 10, []);
    const g2 = setCombineOpacity(setCombineMode(g, cb.id, "stack"), cb.id, cb.data.inputs[0].id, 0.5);
    expect(outputHash(g2, oa.id, "job", 0, 10, [])).toBe(hA);          // A unchanged
    expect(outputHash(g2, ob.id, "job", 0, 10, [])).not.toBe(hB);      // B changed
  });

  it("add/remove combine input slot + medium setter patch correctly", () => {
    let g = emptyGraph();
    const cb = combineNode(0, 0);
    g = { ...g, nodes: [cb] };
    g = addCombineInput(g, cb.id);
    expect(g.nodes[0].data.inputs).toHaveLength(3);
    const slotId = g.nodes[0].data.inputs[2].id;
    g = removeCombineInput(g, cb.id, slotId);
    expect(g.nodes[0].data.inputs).toHaveLength(2);
    g = setCombineMedium(g, cb.id, "vorticity", 9);
    expect(g.nodes[0].data.medium.vorticity).toBe(9);
  });

  it("normalizeGraph fills a partial combine's fields", () => {
    const g = { ...emptyGraph(), nodes: [{ id: "n-x", type: "combine", x: 0, y: 0, data: {} }] };
    const n = normalizeGraph(g).nodes[0];
    expect(n.data.mode).toBe("merge");
    expect(n.data.inputs.length).toBeGreaterThanOrEqual(2);
    expect(n.data.medium.dissipation).toBeDefined();
  });
});

describe("points node (spec 11)", () => {
  it("pointsNode factory: a points array seeded with one centre point", () => {
    const p = pointsNode(0, 0);
    expect(p.type).toBe("points");
    expect(p.data.points).toEqual([[0.5, 0.5]]);
  });

  it("add / move / remove point helpers", () => {
    let g = { ...emptyGraph(), nodes: [pointsNode(0, 0)] };
    const id = g.nodes[0].id;
    g = addPoint(g, id, [0.2, 0.3]);
    expect(g.nodes[0].data.points).toEqual([[0.5, 0.5], [0.2, 0.3]]);
    g = movePoint(g, id, 0, [0.9, 0.9]);
    expect(g.nodes[0].data.points[0]).toEqual([0.9, 0.9]);
    g = removePoint(g, id, 0);
    expect(g.nodes[0].data.points).toEqual([[0.2, 0.3]]);
  });

  it("points -> fluid.positions validates, and moving a point busts the output hash", () => {
    let g = emptyGraph();
    const p = pointsNode(0, 0), f = fluidNode(100, 0), out = outputNode(200, 0);
    g = { ...g, nodes: [p, f, out] };
    g = connectVideo(g, p.id, "out", f.id, "positions");
    g = connectVideo(g, f.id, "out", out.id, "video");
    expect(validate(g).ok).toBe(true);
    expect(outputRenderable(g, out.id)).toBe(true);
    expect(videoSource(g, f.id, "positions")).toBe(p.id);

    const h1 = outputHash(g, out.id, "job", 0, 10, []);
    const g2 = movePoint(g, p.id, 0, [0.1, 0.1]);
    expect(outputHash(g2, out.id, "job", 0, 10, [])).not.toBe(h1);  // point feeds the render
  });

  it("stamps an older (version 1) save up to the current GRAPH_VERSION", () => {
    const g = { version: 1, nodes: [fluidNode(0, 0)], edges: [] };
    expect(normalizeGraph(g).version).toBe(GRAPH_VERSION);
  });

  it("normalizeGraph keeps a points -> fluid.positions edge (not a param port)", () => {
    let g = emptyGraph();
    const p = pointsNode(0, 0), f = fluidNode(0, 0);
    g = { ...g, nodes: [p, f] };
    g = connectVideo(g, p.id, "out", f.id, "positions");
    expect(g.edges).toHaveLength(1);
    expect(normalizeGraph(g).edges).toHaveLength(1);   // must NOT be dropped
  });
});

describe("graph.minimized (persisted, non-rendering)", () => {
  it("does NOT change the render hash (must never bust the cache)", () => {
    const { g, outId } = wiredGraph();
    const h1 = outputHash(g, outId, "job", 0, 8, []);
    const h2 = outputHash({ ...g, minimized: [g.nodes[0].id] }, outId, "job", 0, 8, []);
    expect(h2).toBe(h1);
  });

  it("removeNode prunes the deleted id from graph.minimized", () => {
    const { g, srcId } = wiredGraph();
    const g2 = { ...g, minimized: [srcId, "keep-me"] };
    const g3 = removeNode(g2, srcId);
    expect(g3.minimized).toEqual(["keep-me"]);
  });
});
