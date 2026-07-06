import { describe, it, expect } from "vitest";
import {
  signalNode,
  outputNode,
  fluidNode,
  emptyGraph,
  normalizeGraph,
  GRAPH_VERSION,
  connect,
  disconnect,
  removeNode,
  validate,
  outputHash,
  videoInput,
  combineNode,
  connectVideo,
  videoSource,
  outputRenderable,
  addCombineInput,
  removeCombineInput,
  setCombineMode,
  setCombineOpacity,
  setCombineMedium,
  pointsNode,
  addPoint,
  movePoint,
  removePoint,
  animatePointsNode,
  shaperNode,
  colorNode,
  videoNode,
  mathNode,
  patchNodeData,
  addInputPort,
  removeInputPort,
  setCombineLayer,
  LOOSE_PORT,
  isLooseEdge,
  resolveDropPort,
  connectLoose,
  assignEdge,
  unassignEdge,
} from "../lib/graphModel";
import { FLUID_PARAMS, fluidParam } from "../lib/fluidParams.js";
import { hydrateSegments, serializeSegments, splitAt } from "../lib/segments";
import type {
  CombineData,
  FluidData,
  FluidNode,
  Graph,
  GraphNode,
  Point,
  PointsData,
  SignalData,
  VideoNode as VideoNodeT,
} from "../lib/types";

const STEMS = { original: { sr: 44100 }, drums: { sr: 44100 } };

// A renderable graph: one fluid wired into one output, plus a signal value source.
function wiredGraph() {
  const g = emptyGraph();
  const fluid = fluidNode(0, 0);
  const out = outputNode(0, 0);
  const src = signalNode({ id: "sig-src", name: "src" }, 0, 0);
  g.nodes.push(fluid, out, src);
  // wire fluid -> output (the validate() requirement)
  g.edges.push({
    id: "e-out",
    source: fluid.id,
    sourcePort: "out",
    target: out.id,
    targetPort: "video",
  });
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
    expect(emptyGraph()).toEqual({
      version: GRAPH_VERSION,
      nodes: [],
      edges: [],
      expanded: [], // compact-by-default: nothing expanded in a fresh graph
      view: { tx: 0, ty: 0, scale: 1 },
    });
  });
});

describe("normalizeGraph migrates older saves", () => {
  it("adds missing param ports so they become wireable", () => {
    const { g, fluidId, srcId } = wiredGraph();
    // Simulate a graph saved before a since-added fluid param port existed.
    const fluid = g.nodes.find((n) => n.id === fluidId) as FluidNode;
    delete fluid.data.ports.force;

    const out = normalizeGraph(g);
    const f = out.nodes.find((n) => n.id === fluidId) as FluidNode;
    expect(f.data.ports.force.binding).toEqual({ kind: "const", value: fluidParam("force")!.def });
    expect(Object.keys(f.data.ports).length).toBe(FLUID_PARAMS.length);

    // The previously-broken path (would throw on undefined port) now works.
    const wired = connect(out, srcId, fluidId, "force");
    expect(
      (wired.nodes.find((n) => n.id === fluidId) as FluidNode).data.ports.force.binding
    ).toMatchObject({
      kind: "node",
      nodeId: srcId,
    });
  });

  it("drops stale ports + dangling edges for removed params", () => {
    const { g, fluidId, srcId } = wiredGraph();
    const fluid = g.nodes.find((n) => n.id === fluidId) as FluidNode;
    fluid.data.ports.rot_speed = { binding: { kind: "node", nodeId: srcId, lo: 0, hi: 1 } };
    g.edges.push({
      id: "e-rot",
      source: srcId,
      sourcePort: "out",
      target: fluidId,
      targetPort: "rot_speed",
    });

    const out = normalizeGraph(g);
    const f = out.nodes.find((n) => n.id === fluidId) as FluidNode;
    expect(f.data.ports.rot_speed).toBeUndefined();
    expect(out.edges.find((e) => e.targetPort === "rot_speed")).toBeUndefined();
  });

  it("returns the same object when nothing needs migrating", () => {
    const { g } = wiredGraph();
    expect(normalizeGraph(g)).toBe(g);
  });

  it("drops a pre-v8 `color` (grade FX) node + its edges (v8 rename -> v10 removal)", () => {
    // Before v8 a `color` node was the grade video-FX card. normalizeGraph renames it
    // to `grade` (an unknown type as of v10) and the unknown-type filter drops it —
    // it must NOT be mis-coerced into the modern `color` (dye) card.
    const g = emptyGraph();
    const out = outputNode(0, 0);
    const legacyGrade = {
      id: "n-legacy",
      type: "color",
      x: 0,
      y: 0,
      data: { brightness: 1.2, contrast: 0.9 }, // old grade data, no ports/stops
    } as unknown as GraphNode;
    g.version = 7;
    g.nodes = [legacyGrade, out];
    g.edges = [
      { id: "e1", source: "n-legacy", sourcePort: "out", target: out.id, targetPort: "video" },
    ];
    const norm = normalizeGraph(g);
    expect(norm.nodes.find((n) => n.id === "n-legacy")).toBeUndefined();
    expect(norm.edges.length).toBe(0);
    expect(norm.version).toBe(GRAPH_VERSION);
  });

  it("keeps a v8+ `color` node as the dye card (no legacy rename)", () => {
    const g = emptyGraph(); // already GRAPH_VERSION
    const dye = colorNode(0, 0);
    g.nodes = [dye];
    const norm = normalizeGraph(g);
    const kept = norm.nodes.find((n) => n.id === dye.id);
    expect(kept?.type).toBe("color");
  });

  it("migrates a legacy static video `speed` into a const port binding", () => {
    const g = emptyGraph();
    const v = videoNode(0, 0);
    // A pre-port save: static speed field, no speed port persisted.
    (v.data as unknown as { speed?: number }).speed = 1.5;
    delete (v.data.ports as Record<string, unknown>).speed;
    const saved = { ...v, data: { ...v.data, ports: { ...v.data.ports } } };
    delete (saved.data as unknown as { speed?: number }).speed;
    (saved.data as unknown as { speed?: number }).speed = 1.5;
    g.nodes = [saved as GraphNode];
    const norm = normalizeGraph(g);
    const n = norm.nodes[0] as VideoNodeT;
    expect(n.data.ports.speed.binding).toEqual({ kind: "const", value: 1.5 });
    expect((n.data as unknown as { speed?: number }).speed).toBeUndefined();
  });

  it("a legacy static `speed` does NOT clobber an existing speed port", () => {
    const g = emptyGraph();
    const v = videoNode(0, 0);
    (v.data as unknown as { speed?: number }).speed = 1.5;
    v.data.ports.speed = { binding: { kind: "node", nodeId: "n-lfo", lo: 0.5, hi: 2 } };
    g.nodes = [v as GraphNode, { id: "n-lfo", type: "lfo", x: 0, y: 0, data: {} } as GraphNode];
    const norm = normalizeGraph(g);
    const n = norm.nodes[0] as VideoNodeT;
    expect(n.data.ports.speed.binding).toMatchObject({ kind: "node", nodeId: "n-lfo" });
  });
});

describe("data mutation helpers", () => {
  it("patchNodeData shallow-merges a patch into one node's data", () => {
    const g = emptyGraph();
    const sh = shaperNode(0, 0);
    g.nodes = [sh];
    const out = patchNodeData(g, sh.id, { gain: 2, invert: true });
    const n = out.nodes[0] as typeof sh;
    expect(n.data.gain).toBe(2);
    expect(n.data.invert).toBe(true);
    expect(n.data.release).toBe(250); // untouched fields survive
    expect((g.nodes[0] as typeof sh).data.gain).toBe(1); // immutably
  });

  it("addInputPort appends an input id; removeInputPort drops it AND its wired edge", () => {
    const g = emptyGraph();
    const m = mathNode(0, 0);
    const lfo = { id: "n-lfo", type: "lfo", x: 0, y: 0, data: {} } as GraphNode;
    g.nodes = [m, lfo];
    const g2 = addInputPort(g, m.id);
    const m2 = g2.nodes.find((n) => n.id === m.id) as typeof m;
    expect(m2.data.inputs.length).toBe(3);

    const port = m2.data.inputs[2];
    g2.edges.push({ id: "e-in", source: "n-lfo", sourcePort: "out", target: m.id, targetPort: port });
    const g3 = removeInputPort(g2, m.id, port);
    const m3 = g3.nodes.find((n) => n.id === m.id) as typeof m;
    expect(m3.data.inputs).not.toContain(port);
    expect(g3.edges.find((e) => e.targetPort === port)).toBeUndefined();
  });

  it("setCombineLayer stamps the cross-segment continuity layer", () => {
    const g = emptyGraph();
    const cb = combineNode(0, 0);
    g.nodes = [cb];
    const out = setCombineLayer(g, cb.id, 3);
    expect((out.nodes[0] as typeof cb).data.layer).toBe(3);
  });
});

describe("connect / disconnect keep the binding<->edge invariant", () => {
  it("connect writes the node binding AND an edge; disconnect round-trips to a const with no leftover edge", () => {
    const { g, fluidId, srcId } = wiredGraph();
    const p = fluidParam("force")!;

    const g2 = connect(g, srcId, fluidId, "force");
    const fluid2 = g2.nodes.find((n) => n.id === fluidId) as FluidNode;
    expect(fluid2.data.ports.force.binding).toEqual({
      kind: "node",
      nodeId: srcId,
      lo: p.min,
      hi: p.max,
    });
    expect(g2.edges.filter((e) => e.target === fluidId && e.targetPort === "force")).toHaveLength(
      1
    );

    const g3 = disconnect(g2, fluidId, "force");
    const fluid3 = g3.nodes.find((n) => n.id === fluidId) as FluidNode;
    expect(fluid3.data.ports.force.binding).toEqual({ kind: "const", value: p.def });
    expect(g3.edges.filter((e) => e.target === fluidId && e.targetPort === "force")).toHaveLength(
      0
    );
  });

  it("connecting a port twice replaces the prior edge (no duplicates)", () => {
    const { g, fluidId, srcId } = wiredGraph();
    const g2 = connect(connect(g, srcId, fluidId, "force"), srcId, fluidId, "force");
    expect(g2.edges.filter((e) => e.target === fluidId && e.targetPort === "force")).toHaveLength(
      1
    );
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
    const fluid = g3.nodes.find((n) => n.id === fluidId) as FluidNode;
    expect(fluid.data.ports.force.binding).toEqual({
      kind: "const",
      value: fluidParam("force")!.def,
    });
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
    expect((res as { ok: false; error: string }).error).toMatch(/missing node/);
  });

  it("rejects a non-numeric const binding (malformed graph)", () => {
    const { g, fluidId } = wiredGraph();
    const g2 = {
      ...g,
      nodes: g.nodes.map((n) =>
        n.id === fluidId
          ? ({
              ...n,
              data: {
                ...n.data,
                ports: {
                  ...(n.data as FluidData).ports,
                  force: { binding: { kind: "const", value: "loud" } },
                },
              },
            } as unknown as GraphNode)
          : n
      ),
    };
    expect(validate(g2).ok).toBe(false);
  });
});

// Two independent fluid -> output pipelines in one graph.
function twoPipelines() {
  const g = emptyGraph();
  const fA = fluidNode(0, 0);
  const oA = outputNode(0, 0);
  const fB = fluidNode(0, 0);
  const oB = outputNode(0, 0);
  g.nodes.push(fA, oA, fB, oB);
  g.edges.push(
    { id: "eA", source: fA.id, sourcePort: "out", target: oA.id, targetPort: "video" },
    { id: "eB", source: fB.id, sourcePort: "out", target: oB.id, targetPort: "video" }
  );
  return { g, fA: fA.id, oA: oA.id, fB: fB.id, oB: oB.id };
}

// Set a fluid node's const param value (returns a new graph).
const setForce = (g: Graph, fluidId: string, value: number) => ({
  ...g,
  nodes: g.nodes.map((n) =>
    n.id === fluidId
      ? ({
          ...n,
          data: {
            ...n.data,
            ports: { ...(n.data as FluidData).ports, force: { binding: { kind: "const", value } } },
          },
        } as GraphNode)
      : n
  ),
});

describe("multiple fluid -> output pipelines", () => {
  it("validate accepts two independent pipelines", () => {
    expect(validate(twoPipelines().g)).toEqual({ ok: true });
  });

  it("videoInput resolves each output's own fluid", () => {
    const { g, fA, oA, fB, oB } = twoPipelines();
    expect(videoInput(g, oA)!.id).toBe(fA);
    expect(videoInput(g, oB)!.id).toBe(fB);
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
    const sig = {
      id: "sig-1",
      stemKey: "drums",
      minHz: 40,
      maxHz: 120,
      feature: "energy",
      attack: 5,
      release: 250,
      invert: false,
      gamma: 1,
      gain: 1,
      offset: 0,
      threshold: 0,
    };
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
      [
        {
          start: 0,
          end: 10,
          label: "verse",
          signals: [{ name: "kick", stemKey: "drums", feature: "energy" }],
        },
      ],
      STEMS
    )[0];
    const sigId = seg0.signals[0].id;
    // attach a graph that references the signal
    seg0.graph = { ...emptyGraph(), nodes: [signalNode(seg0.signals[0], 0, 0)] };

    const round = hydrateSegments(serializeSegments([seg0]), STEMS)[0];
    expect(round.graph).toEqual(seg0.graph);
    // the stored signal id survived hydrate, so the graph ref still resolves.
    expect(round.signals.some((s) => s.id === sigId)).toBe(true);
    expect((round.graph!.nodes[0].data as SignalData).signalId).toBe(sigId);
    expect(
      round.signals.some((s) => s.id === (round.graph!.nodes[0].data as SignalData).signalId)
    ).toBe(true);
  });

  it("splitAt gives the cloned half fresh ids + remaps its graph, with distinct graph objects", () => {
    const seg = hydrateSegments(
      [
        {
          start: 0,
          end: 10,
          label: "verse",
          signals: [{ name: "kick", stemKey: "drums", feature: "energy" }],
        },
      ],
      STEMS
    )[0];
    seg.graph = { ...emptyGraph(), nodes: [signalNode(seg.signals[0], 0, 0)] };

    const [a, b] = splitAt([seg], 5);
    // two halves do not share a graph object
    expect(a.graph).not.toBe(b.graph);
    // first half keeps its original signal id + a valid ref
    expect((a.graph!.nodes[0].data as SignalData).signalId).toBe(seg.signals[0].id);
    expect(a.signals.some((s) => s.id === (a.graph!.nodes[0].data as SignalData).signalId)).toBe(
      true
    );
    // second half got fresh signal ids AND a remapped graph (no dangling ref)
    const bRef = (b.graph!.nodes[0].data as SignalData).signalId;
    expect(bRef).not.toBe(seg.signals[0].id);
    expect(b.signals.some((s) => s.id === bRef)).toBe(true);
  });
});

describe("combine nodes (spec 10)", () => {
  // fluidA + fluidB -> combine -> output
  function pipeline() {
    let g = emptyGraph();
    const a = fluidNode(0, 0),
      b = fluidNode(100, 0),
      cb = combineNode(50, 50),
      out = outputNode(200, 0);
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
    const f = fluidNode(0, 0),
      stack = combineNode(0, 0),
      merge = combineNode(0, 0),
      out = outputNode(0, 0);
    g = { ...g, nodes: [f, stack, merge, out] };
    g = setCombineMode(g, stack.id, "stack");
    g = connectVideo(g, f.id, "out", stack.id, stack.data.inputs[0].id);
    g = connectVideo(g, stack.id, "out", merge.id, merge.data.inputs[0].id);
    g = connectVideo(g, merge.id, "out", out.id, "video");
    expect(validate(g).ok).toBe(false);
  });

  it("output passthrough: fluid -> output -> combine -> output2 validates + renderable", () => {
    let g = emptyGraph();
    const f = fluidNode(0, 0),
      o1 = outputNode(0, 0),
      cb = combineNode(0, 0),
      o2 = outputNode(0, 0);
    g = { ...g, nodes: [f, o1, cb, o2] };
    g = connectVideo(g, f.id, "out", o1.id, "video");
    g = connectVideo(g, o1.id, "video", cb.id, cb.data.inputs[0].id);
    g = connectVideo(g, cb.id, "out", o2.id, "video");
    expect(validate(g).ok).toBe(true);
    expect(outputRenderable(g, o2.id)).toBe(true);
  });

  it("outputRenderable false when a combine has no wired input", () => {
    let g = emptyGraph();
    const cb = combineNode(0, 0),
      out = outputNode(0, 0);
    g = { ...g, nodes: [cb, out] };
    g = connectVideo(g, cb.id, "out", out.id, "video");
    expect(outputRenderable(g, out.id)).toBe(false);
  });

  it("outputHash isolates pipelines: editing combine B doesn't change output A's hash", () => {
    let g = emptyGraph();
    const fa = fluidNode(0, 0),
      ca = combineNode(0, 0),
      oa = outputNode(0, 0);
    const fb = fluidNode(0, 0),
      cb = combineNode(0, 0),
      ob = outputNode(0, 0);
    g = { ...g, nodes: [fa, ca, oa, fb, cb, ob] };
    g = connectVideo(g, fa.id, "out", ca.id, ca.data.inputs[0].id);
    g = connectVideo(g, ca.id, "out", oa.id, "video");
    g = connectVideo(g, fb.id, "out", cb.id, cb.data.inputs[0].id);
    g = connectVideo(g, cb.id, "out", ob.id, "video");
    const hA = outputHash(g, oa.id, "job", 0, 10, []);
    const hB = outputHash(g, ob.id, "job", 0, 10, []);
    const g2 = setCombineOpacity(
      setCombineMode(g, cb.id, "stack"),
      cb.id,
      cb.data.inputs[0].id,
      0.5
    );
    expect(outputHash(g2, oa.id, "job", 0, 10, [])).toBe(hA); // A unchanged
    expect(outputHash(g2, ob.id, "job", 0, 10, [])).not.toBe(hB); // B changed
  });

  it("add/remove combine input slot + medium setter patch correctly", () => {
    let g = emptyGraph();
    const cb = combineNode(0, 0);
    g = { ...g, nodes: [cb] };
    g = addCombineInput(g, cb.id);
    expect((g.nodes[0].data as CombineData).inputs).toHaveLength(3);
    const slotId = (g.nodes[0].data as CombineData).inputs[2].id;
    g = removeCombineInput(g, cb.id, slotId);
    expect((g.nodes[0].data as CombineData).inputs).toHaveLength(2);
    g = setCombineMedium(g, cb.id, "vorticity", 9);
    expect((g.nodes[0].data as CombineData).medium.vorticity).toBe(9);
  });

  it("normalizeGraph fills a partial combine's fields", () => {
    const g = {
      ...emptyGraph(),
      nodes: [{ id: "n-x", type: "combine", x: 0, y: 0, data: {} } as unknown as GraphNode],
    };
    const n = normalizeGraph(g).nodes[0];
    expect((n.data as CombineData).mode).toBe("merge");
    expect((n.data as CombineData).inputs.length).toBeGreaterThanOrEqual(2);
    expect((n.data as CombineData).medium.dissipation).toBeDefined();
  });
});

describe("points node (spec 11)", () => {
  it("pointsNode factory: a points array seeded with one centre point", () => {
    const p = pointsNode(0, 0);
    expect(p.type).toBe("points");
    expect((p.data as PointsData).points).toEqual([[0.5, 0.5]]);
  });

  it("add / move / remove point helpers", () => {
    let g: Graph = { ...emptyGraph(), nodes: [pointsNode(0, 0)] };
    const id = g.nodes[0].id;
    g = addPoint(g, id, [0.2, 0.3] as Point);
    expect((g.nodes[0].data as PointsData).points).toEqual([
      [0.5, 0.5],
      [0.2, 0.3],
    ]);
    g = movePoint(g, id, 0, [0.9, 0.9] as Point);
    expect((g.nodes[0].data as PointsData).points[0]).toEqual([0.9, 0.9]);
    g = removePoint(g, id, 0);
    expect((g.nodes[0].data as PointsData).points).toEqual([[0.2, 0.3]]);
  });

  it("points -> fluid.positions validates, and moving a point busts the output hash", () => {
    let g = emptyGraph();
    const p = pointsNode(0, 0),
      f = fluidNode(100, 0),
      out = outputNode(200, 0);
    g = { ...g, nodes: [p, f, out] };
    g = connectVideo(g, p.id, "out", f.id, "positions");
    g = connectVideo(g, f.id, "out", out.id, "video");
    expect(validate(g).ok).toBe(true);
    expect(outputRenderable(g, out.id)).toBe(true);
    expect(videoSource(g, f.id, "positions")).toBe(p.id);

    const h1 = outputHash(g, out.id, "job", 0, 10, []);
    const g2 = movePoint(g, p.id, 0, [0.1, 0.1] as Point);
    expect(outputHash(g2, out.id, "job", 0, 10, [])).not.toBe(h1); // point feeds the render
  });

  it("stamps an older (version 1) save up to the current GRAPH_VERSION", () => {
    const g = { version: 1, nodes: [fluidNode(0, 0)], edges: [] };
    expect(normalizeGraph(g).version).toBe(GRAPH_VERSION);
  });

  it("normalizeGraph keeps a points -> fluid.positions edge (not a param port)", () => {
    let g = emptyGraph();
    const p = pointsNode(0, 0),
      f = fluidNode(0, 0);
    g = { ...g, nodes: [p, f] };
    g = connectVideo(g, p.id, "out", f.id, "positions");
    expect(g.edges).toHaveLength(1);
    expect(normalizeGraph(g).edges).toHaveLength(1); // must NOT be dropped
  });

  it("animatePointsNode factory carries chase fields (count, fade)", () => {
    const a = animatePointsNode(0, 0);
    expect(a.type).toBe("animate-points");
    expect(a.data).toEqual({ mode: "orbit", amount: 0.15, rate: 1, angle: 0, count: 3, fade: 1 });
  });

  it("shaperNode factory carries delay/wrap defaults (0, false)", () => {
    const s = shaperNode(0, 0);
    expect(s.type).toBe("shaper");
    expect(s.data.delay).toBe(0);
    expect(s.data.wrap).toBe(false);
  });

  it("normalizeGraph back-fills delay/wrap for a legacy shaper save", () => {
    const g = {
      version: 8,
      nodes: [
        {
          id: "s1",
          type: "shaper",
          x: 0,
          y: 0,
          data: {
            attack: 5,
            release: 250,
            invert: false,
            threshold: 0,
            gamma: 1,
            gain: 1,
            offset: 0,
            lo: 0,
            hi: 1,
          },
        } as unknown as GraphNode,
      ],
      edges: [],
    };
    const out = normalizeGraph(g);
    expect(out.version).toBe(GRAPH_VERSION);
    expect(out.nodes[0].data).toMatchObject({ delay: 0, wrap: false });
  });

  it("normalizeGraph fills count/fade for a legacy animate-points save", () => {
    const g = {
      ...emptyGraph(),
      nodes: [
        {
          id: "a1",
          type: "animate-points",
          x: 0,
          y: 0,
          data: { mode: "chase", amount: 0.15, rate: 2, angle: 0 },
        } as unknown as GraphNode,
      ],
    };
    const n = normalizeGraph(g).nodes[0];
    expect(n.data).toEqual({ mode: "chase", amount: 0.15, rate: 2, angle: 0, count: 3, fade: 1 });
  });
});

describe("graph.expanded (persisted, non-rendering)", () => {
  it("does NOT change the render hash (must never bust the cache)", () => {
    const { g, outId } = wiredGraph();
    const h1 = outputHash(g, outId, "job", 0, 8, []);
    const h2 = outputHash({ ...g, expanded: [g.nodes[0].id] }, outId, "job", 0, 8, []);
    expect(h2).toBe(h1);
  });

  it("removeNode prunes the deleted id from graph.expanded", () => {
    const { g, srcId } = wiredGraph();
    const g2 = { ...g, expanded: [srcId, "keep-me"] };
    const g3 = removeNode(g2, srcId);
    expect(g3.expanded).toEqual(["keep-me"]);
  });

  it("removeNode also prunes the legacy pre-v13 minimized set", () => {
    const { g, srcId } = wiredGraph();
    const g2 = { ...g, minimized: [srcId, "keep-me"] };
    const g3 = removeNode(g2, srcId);
    expect(g3.minimized).toEqual(["keep-me"]);
  });
});

describe("v13 migration: minimized -> expanded (compact by default)", () => {
  // A pre-v13 save: version 12, no `expanded` field yet.
  const v12 = () => {
    const { g, fluidId, outId, srcId } = wiredGraph();
    // emptyGraph() now seeds `expanded: []` — a REAL v12 save has no such field,
    // so strip it or the migration would (correctly) preserve it instead of inverting.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { expanded: _expanded, ...v12g } = g;
    return { g: { ...v12g, version: 12 } as Graph, fluidId, outId, srcId };
  };

  it("inverts a v12 minimized set into expanded and strips minimized", () => {
    const { g, fluidId, outId, srcId } = v12();
    const out = normalizeGraph({ ...g, minimized: [fluidId] });
    // minimized:[fluid] of {fluid, out, src} -> expanded:[out, src]
    expect(new Set(out.expanded)).toEqual(new Set([outId, srcId]));
    expect("minimized" in out).toBe(false);
    expect(out.version).toBe(GRAPH_VERSION);
  });

  it("a v12 save without minimized expands ALL nodes (old saves showed full cards)", () => {
    const { g } = v12();
    const out = normalizeGraph(g);
    expect(new Set(out.expanded)).toEqual(new Set(g.nodes.map((n) => n.id)));
    expect("minimized" in out).toBe(false);
  });

  it("a v13 save keeps its expanded set, filtered to live node ids", () => {
    const { g, srcId } = wiredGraph();
    const out = normalizeGraph({ ...g, expanded: [srcId, "gone-node"] });
    expect(out.expanded).toEqual([srcId]);
  });

  it("is idempotent (normalizing twice returns the same object)", () => {
    const { g, fluidId } = v12();
    const once = normalizeGraph({ ...g, minimized: [fluidId] });
    expect(normalizeGraph(once)).toBe(once);
  });
});

describe("loose edges (v14): drop-anywhere wiring", () => {
  it("connectLoose parks a gray edge with the sentinel port and no binding (deduped)", () => {
    const { g, fluidId, srcId } = wiredGraph();
    const g2 = connectLoose(g, srcId, fluidId);
    const loose = g2.edges.find((e) => isLooseEdge(e))!;
    expect(loose).toMatchObject({ source: srcId, target: fluidId, targetPort: LOOSE_PORT });
    // no binding was written on any fluid port
    const fluid = g2.nodes.find((n) => n.id === fluidId) as FluidNode;
    for (const p of Object.values(fluid.data.ports)) expect(p.binding.kind).toBe("const");
    // re-dropping the same wire is a no-op
    expect(connectLoose(g2, srcId, fluidId)).toBe(g2);
  });

  it("resolveDropPort: output video / combine free slot / fluid positions / single value port", () => {
    const { g, fluidId, outId } = wiredGraph();
    expect(resolveDropPort(g, outId, "video")).toBe(null); // video port already wired
    const cb = combineNode(0, 0);
    const g2 = { ...g, nodes: [...g.nodes, cb] };
    expect(resolveDropPort(g2, cb.id, "video")).toBe(cb.data.inputs[0].id); // first free slot
    expect(resolveDropPort(g2, fluidId, "points")).toBe("positions");
    // value into a fluid: MANY unbound params -> ambiguous -> loose
    expect(resolveDropPort(g2, fluidId, "value")).toBe(null);
    // value into a single-port card (backdrop: only opacity) -> that port
    const bd = { id: "n-bd", type: "backdrop", x: 0, y: 0,
      data: { color: "#101418", ports: { opacity: { binding: { kind: "const", value: 1 } } } } } as GraphNode;
    const g3 = { ...g2, nodes: [...g2.nodes, bd] };
    expect(resolveDropPort(g3, "n-bd", "value")).toBe("opacity");
  });

  it("assignEdge promotes loose -> real connect (binding restored); unassignEdge demotes", () => {
    const { g, fluidId, srcId } = wiredGraph();
    const g2 = connectLoose(g, srcId, fluidId);
    const looseId = g2.edges.find((e) => isLooseEdge(e))!.id;
    const g3 = assignEdge(g2, looseId, "force");
    expect(g3.edges.some((e) => isLooseEdge(e))).toBe(false);
    const fluid = g3.nodes.find((n) => n.id === fluidId) as FluidNode;
    expect(fluid.data.ports.force.binding).toMatchObject({ kind: "node", nodeId: srcId });
    // and back again
    const g4 = unassignEdge(g3, fluidId, "force");
    expect(g4.edges.some((e) => isLooseEdge(e))).toBe(true);
    const fluid4 = g4.nodes.find((n) => n.id === fluidId) as FluidNode;
    expect(fluid4.data.ports.force.binding.kind).toBe("const");
  });

  it("a loose edge never changes the output hash or renderability", () => {
    const { g, fluidId, outId, srcId } = wiredGraph();
    const before = outputHash(g, outId, "job", 0, 8, []);
    const g2 = connectLoose(g, srcId, fluidId);
    expect(outputHash(g2, outId, "job", 0, 8, [])).toBe(before);
    expect(outputRenderable(g2, outId)).toBe(true);
    expect(validate(g2).ok).toBe(true);
  });

  it("normalizeGraph keeps loose edges (incl. ones parked on a fluid)", () => {
    const { g, fluidId, srcId } = wiredGraph();
    const g2 = connectLoose(g, srcId, fluidId);
    const norm = normalizeGraph({ ...g2, version: 13 });
    expect(norm.edges.some((e) => isLooseEdge(e))).toBe(true);
  });
});
