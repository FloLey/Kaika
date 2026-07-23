import { describe, it, expect } from "vitest";
import {
  emptyGraph,
  fluidNode,
  lfoNode,
  signalNode,
  montageNode,
  connect,
  connectLoose,
  addExtract,
  addManualBreakpoint,
  copySelection,
  pasteClipboard,
  writeClipboard,
  readClipboard,
  nextPasteOffset,
} from "../lib/graphModel";
import type { Graph, MontageData, Signal, SignalData } from "../lib/types";

// Copy/paste of card groups (lib/graph/clipboard): the selection travels with the
// edges AMONG it, bindings referencing outside nodes are dropped at copy (the
// binding↔edge invariant must hold inside the clipboard too), paste re-mints every
// id, and a signal card pasted into another segment re-points by SIGNATURE — the
// same {stem, band, feature} match the render's ref fallback uses.

const sig = (id: string, over: Partial<Signal> = {}): Signal => ({
  id,
  stemKey: "drums",
  minHz: 20,
  maxHz: 200,
  feature: "energy",
  attack: 0,
  release: 0,
  invert: false,
  gamma: 1,
  gain: 1,
  offset: 0,
  threshold: 0,
  ...over,
});

// lfo → fluid.force (a param binding + its edge), plus an OUTSIDE lfo bound to
// fluid.emit that must NOT survive a copy of {lfo, fluid} minus it.
function rig() {
  const lfo = lfoNode(0, 0);
  const outside = lfoNode(0, 200);
  const fluid = fluidNode(200, 0);
  let g: Graph = { ...emptyGraph(), nodes: [lfo, outside, fluid] };
  g = connect(g, lfo.id, fluid.id, "force");
  g = connect(g, outside.id, fluid.id, "emit");
  return { g, lfo, outside, fluid };
}

describe("copySelection", () => {
  it("takes the selected nodes and the non-loose edges among them", () => {
    const { g, lfo, fluid } = rig();
    const clip = copySelection(g, new Set([lfo.id, fluid.id]))!;
    expect(clip.nodes.map((n) => n.id).sort()).toEqual([lfo.id, fluid.id].sort());
    expect(clip.edges).toHaveLength(1); // lfo→force; the outside lfo's edge stayed behind
    expect(clip.edges[0].targetPort).toBe("force");
  });

  it("drops bindings (and edges) that reach outside the selection — invariant intact", () => {
    const { g, lfo, fluid } = rig();
    const clip = copySelection(g, new Set([lfo.id, fluid.id]))!;
    const f = clip.nodes.find((n) => n.id === fluid.id)!;
    const ports = (f.data as { ports: Record<string, { binding?: unknown }> }).ports;
    expect(ports.force.binding).toBeTruthy(); // inside — kept
    expect(ports.emit.binding).toBeUndefined(); // outside — dropped with its edge
  });

  it("leaves loose (parked) edges behind and refuses an edge-only selection", () => {
    const { g, lfo, fluid } = rig();
    const g2 = connectLoose(g, lfo.id, fluid.id);
    const loose = g2.edges.find((e) => e.targetPort === "__in")!;
    const clip = copySelection(g2, new Set([lfo.id, fluid.id]))!;
    expect(clip.edges.some((e) => e.targetPort === "__in")).toBe(false);
    expect(copySelection(g2, new Set([loose.id]))).toBeNull();
  });

  it("is a deep snapshot — later graph edits never reach into the clipboard", () => {
    const { g, lfo, fluid } = rig();
    const clip = copySelection(g, new Set([lfo.id, fluid.id]))!;
    (g.nodes.find((n) => n.id === lfo.id)!.data as { rate?: number }).rate = 999;
    expect((clip.nodes.find((n) => n.id === lfo.id)!.data as { rate?: number }).rate).not.toBe(999);
  });
});

describe("pasteClipboard", () => {
  it("re-mints node and edge ids, remaps them consistently, and offsets positions", () => {
    const { g, lfo, fluid } = rig();
    const clip = copySelection(g, new Set([lfo.id, fluid.id]))!;
    const { graph: g2, ids } = pasteClipboard(g, clip, { offset: { x: 28, y: 28 } });
    expect(g2.nodes).toHaveLength(5);
    expect(ids).toHaveLength(2);
    expect(ids.every((id) => ![lfo.id, fluid.id].includes(id))).toBe(true);
    const pastedFluid = g2.nodes.find((n) => ids.includes(n.id) && n.type === "fluid")!;
    const pastedLfo = g2.nodes.find((n) => ids.includes(n.id) && n.type === "lfo")!;
    expect(pastedFluid.x).toBe(fluid.x + 28);
    // The pasted binding + edge point at the pasted lfo, not the original.
    const b = (pastedFluid.data as { ports: Record<string, { binding?: { nodeId?: string } }> })
      .ports.force.binding!;
    expect(b.nodeId).toBe(pastedLfo.id);
    const edge = g2.edges.find((e) => e.target === pastedFluid.id && e.targetPort === "force")!;
    expect(edge.source).toBe(pastedLfo.id);
    expect(g2.edges.filter((e) => e.id === edge.id)).toHaveLength(1); // fresh edge id
  });

  it("re-mints a montage's extract/breakpoint ids but KEEPS composition references", () => {
    const mg = montageNode(0, 0);
    let g: Graph = { ...emptyGraph(), nodes: [mg] };
    g = addExtract(g, mg.id, "comp-shared");
    g = addManualBreakpoint(g, mg.id, 2.0);
    const orig = g.nodes[0].data as MontageData;
    const clip = copySelection(g, new Set([mg.id]))!;
    const { graph: g2, ids } = pasteClipboard(g, clip, { offset: { x: 0, y: 0 } });
    const pasted = g2.nodes.find((n) => n.id === ids[0])!.data as MontageData;
    expect(pasted.extracts[0].compositionId).toBe("comp-shared"); // shared child (DAG)
    expect(pasted.extracts[0].id).not.toBe(orig.extracts[0].id);
    expect(pasted.manualBreakpoints[0].id).not.toBe(orig.manualBreakpoints[0].id);
    expect(pasted.manualBreakpoints[0].t).toBe(2.0);
  });

  it("re-points a signal card at the target segment's signals by signature", () => {
    const source = sig("sig-src");
    const sn = signalNode({ ...source, name: "kick" }, 0, 0);
    const g: Graph = { ...emptyGraph(), nodes: [sn] };
    const clip = copySelection(g, new Set([sn.id]))!;
    // Target segment: same drums/20–200/energy signature under a different UUID.
    const target = [sig("sig-tgt", { name: "kick (verse)" }), sig("other", { stemKey: "bass" })];
    const { graph: g2, ids } = pasteClipboard(emptyGraph(), clip, { signals: target });
    const pasted = g2.nodes.find((n) => n.id === ids[0])!.data as SignalData;
    expect(pasted.signalId).toBe("sig-tgt");
    expect(pasted.label).toBe("kick (verse)");
    // No signature match → left as-is (renders through the ref fallback, shows missing).
    const { graph: g3, ids: ids3 } = pasteClipboard(emptyGraph(), clip, {
      signals: [sig("other", { stemKey: "bass" })],
    });
    expect((g3.nodes.find((n) => n.id === ids3[0])!.data as SignalData).signalId).toBe("sig-src");
    // Exact id present in the target (same segment) → untouched.
    const { graph: g4, ids: ids4 } = pasteClipboard(emptyGraph(), clip, {
      signals: [sig("sig-src", { name: "renamed" })],
    });
    expect((g4.nodes.find((n) => n.id === ids4[0])!.data as SignalData).signalId).toBe("sig-src");
  });
});

describe("the module clipboard", () => {
  it("round-trips and staggers consecutive pastes; a new copy resets the stagger", () => {
    const { g, lfo } = rig();
    const clip = copySelection(g, new Set([lfo.id]))!;
    writeClipboard(clip);
    expect(readClipboard()).toBe(clip);
    expect(nextPasteOffset()).toEqual({ x: 28, y: 28 });
    expect(nextPasteOffset()).toEqual({ x: 56, y: 56 });
    writeClipboard(clip);
    expect(nextPasteOffset()).toEqual({ x: 28, y: 28 });
  });
});
