// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import MontageEditor from "../components/animation/MontageEditor";
import { emptyGraph, montageNode, lfoNode, connect, addExtract } from "../lib/graphModel";
import { leafComposition } from "../lib/compositions";
import type { CompositionPool, Graph, MontageNode, Segment } from "../lib/types";
import type { NodeCtx } from "../components/animation/nodes/nodeProps";

// The breakpoints timeline (specs/compositions step 06): both cut sources on one
// strip with visible provenance — gate cuts toggle off/on (greyed, never hidden),
// manual cuts place/drag/delete — and the montage's data records exactly what the
// render will consume (lib/montageCuts mirrors backend _effective_cuts).

beforeAll(() => {
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
});

vi.mock("../lib/api", async (orig) => ({
  ...(await orig<typeof import("../lib/api")>()),
  startStreamRender: vi.fn(() => new Promise(() => {})),
  // 240 frames at 30fps over 8s; one gate rise at frame 120 → a gate cut at 4s.
  resolveCurve: vi.fn(async () => ({
    curve: [...new Array(120).fill(0), ...new Array(120).fill(1)],
    fps: 30,
  })),
}));

const segment: Segment = { id: "s1", label: "verse", start: 0, end: 8, signals: [] };

function rig() {
  const clip = leafComposition({ url: "/assets/j/a.mp4", name: "clip A", kind: "video" });
  const mg = montageNode(400, 0);
  const osc = lfoNode(0, 400);
  let g: Graph = { ...emptyGraph(), nodes: [mg, osc] };
  g = addExtract(g, mg.id, clip.id);
  g = connect(g, osc.id, mg.id, "trigger");
  const pool: CompositionPool = { [clip.id]: clip };
  return { graph: g, mgId: mg.id, pool };
}

function mountEditor() {
  const r = rig();
  let graph = r.graph;
  const onGraphChange = (updater: (g: Graph) => Graph) => {
    graph = updater(graph);
    rerender(ui());
  };
  const ctx = (): NodeCtx => ({
    graph,
    segment,
    compositions: r.pool,
    signals: [],
    assets: [],
    job: "j",
    updateCompositions: vi.fn(),
    onGraphChange,
  });
  const node = () => graph.nodes.find((n) => n.id === r.mgId) as MontageNode;
  const ui = () => <MontageEditor node={node()} ctx={ctx()} onGraphChange={onGraphChange} />;
  const { container, rerender } = render(ui());
  return { container, node, mgId: r.mgId };
}

describe("breakpoints timeline", () => {
  it("shows the gate cut; clicking it toggles a disabled exception (still visible)", async () => {
    const { container, node } = mountEditor();
    const gate = await waitFor(() => {
      const el = container.querySelector(".bp-gate");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    fireEvent.click(gate);
    // The exception is stored at the cut's time (4s), and the mark stays VISIBLE,
    // greyed — provenance never disappears.
    expect(node().data.disabledCuts).toHaveLength(1);
    expect(node().data.disabledCuts[0]).toBeCloseTo(4, 3);
    const off = container.querySelector(".bp-gate.off");
    expect(off).toBeTruthy();
    // …and the schedule dropped to zero effective cuts.
    expect(container.textContent).toMatch(/cuts\s*0×/);
    // Clicking again re-enables (the half-frame tolerance round-trips).
    fireEvent.click(off!);
    expect(node().data.disabledCuts).toHaveLength(0);
  });

  it("click on empty rail places a manual cut; click on the mark deletes it", async () => {
    const { container, node } = mountEditor();
    const rail = await waitFor(() => {
      const el = container.querySelector(".bp-rail");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    // jsdom rects are 0-wide — stub the rail's box so frameAtX resolves (240 px =
    // 1px/frame). And jsdom's fireEvent drops clientX on pointer events — dispatch
    // NATIVE events (they bubble into React's delegated pointerdown), the same
    // workaround the canvas drag test uses.
    rail.getBoundingClientRect = () =>
      ({ left: 0, width: 240, top: 0, height: 26, right: 240, bottom: 26 }) as DOMRect;
    const ptr = (type: string, x: number) =>
      Object.assign(new Event(type, { bubbles: true }), { clientX: x, button: 0 });
    fireEvent(rail, ptr("pointerdown", 60)); // frame 60 → 2.0s
    expect(node().data.manualBreakpoints).toHaveLength(1);
    expect(node().data.manualBreakpoints[0].t).toBeCloseTo(2, 3);

    // The manual mark renders in its own colour; pointer-down + up without moving
    // is the delete gesture.
    const manual = await waitFor(() => {
      const el = container.querySelector(".bp-manual");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    fireEvent(manual, ptr("pointerdown", 60));
    fireEvent(window, ptr("pointerup", 60));
    expect(node().data.manualBreakpoints).toHaveLength(0);
  });
});
