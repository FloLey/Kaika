// @vitest-environment jsdom
// DAG sharing in the montage editor (specs/compositions step 07): the ⟳ reuse
// picker lists the pool with "used ×N", HIDES anything that would make this
// composition contain itself, and picking adds a reference; removing the LAST
// reference to a composition asks first (the save-time prune will collect it).

import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import MontageEditor from "../components/animation/MontageEditor";
import { emptyGraph, montageNode, addExtract } from "../lib/graphModel";
import { leafComposition, refCounts } from "../lib/compositions";
import type { CompositionPool, Graph, MontageNode, Segment } from "../lib/types";
import type { NodeCtx } from "../components/animation/nodes/nodeProps";

beforeAll(() => {
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
});

vi.mock("../lib/api", async (orig) => ({
  ...(await orig<typeof import("../lib/api")>()),
  startStreamRender: vi.fn(() => new Promise(() => {})),
  resolveCurve: vi.fn(() => new Promise(() => {})),
}));

const segment: Segment = { id: "s1", label: "verse", start: 0, end: 8, signals: [] };

function mountEditor() {
  const clipA = leafComposition({ url: "/assets/j/a.mp4", name: "clip A", kind: "video" });
  const clipB = leafComposition({ url: "/assets/j/b.mp4", name: "clip B", kind: "video" });
  const mg = montageNode(0, 0);
  let graph: Graph = { ...emptyGraph(), nodes: [mg] };
  graph = addExtract(graph, mg.id, clipA.id);
  const hostId = "comp-host";
  const pool: CompositionPool = {
    [clipA.id]: clipA,
    [clipB.id]: clipB,
    // the HOST composition (holds this montage) and an ANCESTOR referencing it —
    // both must be hidden by the reuse picker.
    [hostId]: { id: hostId, name: "host", graph },
    "comp-parent": {
      id: "comp-parent",
      name: "parent",
      graph: (() => {
        const outer = montageNode(0, 0);
        let g: Graph = { ...emptyGraph(), nodes: [outer] };
        g = addExtract(g, outer.id, hostId);
        return g;
      })(),
    },
  };
  const segs = [{ ...segment, rootCompositionId: "comp-parent" }];
  const onGraphChange = (updater: (g: Graph) => Graph) => {
    graph = updater(graph);
    pool[hostId] = { ...pool[hostId], graph };
    rerender(ui());
  };
  const ctx = (): NodeCtx => ({
    graph,
    segment,
    compositions: pool,
    compositionId: hostId,
    refCounts: refCounts(pool, segs),
    signals: [],
    assets: [],
    job: "j",
    updateCompositions: vi.fn(),
    onGraphChange,
  });
  const node = () => graph.nodes.find((n) => n.id === mg.id) as MontageNode;
  const ui = () => <MontageEditor node={node()} ctx={ctx()} onGraphChange={onGraphChange} />;
  const { container, rerender, getByText, queryByText } = render(ui());
  return { container, node, getByText, queryByText, clipB };
}

describe("montage sharing", () => {
  it("⟳ reuse lists the pool with use counts, hides self and ancestors, and adds on pick", async () => {
    const { container, node, getByText, queryByText } = mountEditor();
    fireEvent.click(getByText("⟳ reuse"));
    const rows = await waitFor(() => {
      const els = container.querySelectorAll(".montage-reuse-row");
      expect(els.length).toBeGreaterThan(0);
      return [...els];
    });
    const names = rows.map((r) => r.querySelector(".montage-reuse-name")?.textContent);
    expect(names).toContain("clip A");
    expect(names).toContain("clip B");
    expect(names).not.toContain("host"); // self
    expect(names).not.toContain("parent"); // ancestor — would close a cycle
    // clip A is referenced once already (our extract) — the indicator says so.
    const rowA = rows.find((r) => r.textContent?.includes("clip A"))!;
    expect(rowA.textContent).toMatch(/used ×1/);

    fireEvent.click(rows.find((r) => r.textContent?.includes("clip B"))!);
    expect(node().data.extracts.map((x) => x.compositionId)).toHaveLength(2);
    expect(queryByText(/reuse a composition/)).toBeNull(); // picker closed
  });

  it("removing the LAST reference asks first; other references remove silently", async () => {
    const { container, node, getByText } = mountEditor();
    // clip A is used once → ✕ must confirm.
    fireEvent.click(container.querySelector(".anim-combine-rm")!);
    expect(getByText(/last reference to “clip A”/)).toBeTruthy();
    fireEvent.click(getByText("Remove"));
    await waitFor(() => expect(node().data.extracts).toHaveLength(0));
  });
});
