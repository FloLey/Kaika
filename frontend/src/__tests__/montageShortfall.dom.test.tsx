// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, waitFor, fireEvent } from "@testing-library/react";
import AnimationCanvas from "../components/animation/AnimationCanvas";
import { emptyGraph, montageNode, lfoNode, connect, addExtract } from "../lib/graphModel";
import { leafComposition } from "../lib/compositions";
import type { Asset, CompositionPool, Graph, Segment } from "../lib/types";

// A real 4K export went out with 1.23s of BLACK in it. The per-row shortfall badge was
// sitting on the offending row the whole time — on row 34 of 37 — and its tooltip said
// the slot "freezes on its last frame", which stopped being true when a video card out
// of material started rendering BLANK (RENDER_VERSION v14). So the card both hid the
// warning in a crowd and, once found, described the wrong symptom. The extract model
// keeps the same guarantees: the roll-up rides the compact card and the modal header,
// reading the clip through the extract's LEAF composition.

vi.mock("../lib/api", async (orig) => ({
  ...(await orig<typeof import("../lib/api")>()),
  startStreamRender: vi.fn(() => new Promise(() => {})),
  // A flat curve: no rises, so extract 1 spans the whole segment — 8s for a 2s clip.
  resolveCurve: vi.fn(async () => ({ curve: new Array(240).fill(0), fps: 30 })),
}));

const segment: Segment = { id: "s1", label: "verse", start: 0, end: 8, signals: [] };

const ASSETS: Asset[] = [
  {
    id: "a",
    url: "/assets/j/short.mp4",
    kind: "video",
    name: "short.mp4",
    addedAt: 0,
    duration: 2,
  },
];

function rig(loop: boolean): { graph: Graph; pool: CompositionPool } {
  const mg = montageNode(400, 0);
  const osc = lfoNode(0, 400);
  const comp = leafComposition({ url: "/assets/j/short.mp4", name: "short.mp4", kind: "video" });
  const vid = comp.graph.nodes.find((n) => n.type === "video")!;
  (vid.data as { loop: boolean }).loop = loop;
  let g: Graph = { ...emptyGraph(), nodes: [mg, osc] };
  g = addExtract(g, mg.id, comp.id);
  g = connect(g, osc.id, mg.id, "trigger"); // a node-bound trigger, so the cuts resolve
  return { graph: g, pool: { [comp.id]: comp } };
}

const mount = (r: { graph: Graph; pool: CompositionPool }, assets: Asset[] = ASSETS) =>
  render(
    <AnimationCanvas
      segment={segment}
      graph={r.graph}
      compositions={r.pool}
      job="j"
      assets={assets}
      onGraphChange={() => {}}
    />
  );

describe("Montage — an extract short of material", () => {
  it("rolls up the black on the compact card, naming the extract and the shortfall", async () => {
    const { findByTitle } = mount(rig(false));
    const summary = await findByTitle(/short of material/i);
    expect(summary.textContent).toMatch(/6\.0s black/);
    expect(summary.getAttribute("title")).toMatch(/extract 1 \(−6\.0s\)/);
    // The wording is the post-v14 truth (goes BLACK), not the old harmless "freezes".
    expect(summary.getAttribute("title")).toMatch(/goes BLACK/);
    expect(summary.getAttribute("title")).not.toMatch(/freezes on its last frame/);
  });

  it("shows no black roll-up when the short clip merely loops", async () => {
    const { queryByTitle } = mount(rig(true));
    // A looping clip is short but never dark — not an export defect, so no roll-up.
    await waitFor(() => expect(queryByTitle(/short of material/i)).toBeNull());
  });

  it("the settings modal shows the extract list and the same warning in its header", async () => {
    const { container, findByText, getByRole } = mount(rig(false));
    fireEvent.click(container.querySelector(".anim-compact-body")!);
    const dialog = getByRole("dialog");
    expect(dialog.className).toContain("node-settings");
    // one extract row, on the CARD (extracts are data, not wiring — the INPUTS panel
    // carries only the trigger/opacity params now)
    await waitFor(() => expect(dialog.querySelectorAll(".anim-combine-row").length).toBe(1));
    await findByText(/6\.0s black/); // the roll-up rides the card's status line
  });

  it("stays quiet when the clip covers its extract", async () => {
    const long: Asset[] = [{ ...ASSETS[0], duration: 30 }];
    const { queryByTitle } = mount(rig(false), long);
    await waitFor(() => expect(queryByTitle(/short of material/i)).toBeNull());
  });
});
