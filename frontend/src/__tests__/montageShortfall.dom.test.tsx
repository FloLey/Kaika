// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import AnimationCanvas from "../components/animation/AnimationCanvas";
import {
  emptyGraph,
  montageNode,
  videoNode,
  lfoNode,
  connect,
  connectVideo,
} from "../lib/graphModel";
import type { Asset, Graph, Segment } from "../lib/types";

// A real 4K export went out with 1.23s of BLACK in it. The per-row shortfall badge was
// sitting on the offending row the whole time — on row 34 of 37 — and its tooltip said the
// slot "freezes on its last frame", which stopped being true when a video card out of
// material started rendering BLANK (RENDER_VERSION v14). So the card both hid the warning
// in a crowd and, once found, described the wrong symptom.

vi.mock("../lib/api", async (orig) => ({
  ...(await orig<typeof import("../lib/api")>()),
  startStreamRender: vi.fn(() => new Promise(() => {})),
  // A flat curve: no rises, so slot 1 spans the whole segment — 8s for a 2s clip.
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

function oneShortSlot(loop: boolean): Graph {
  const mg = montageNode(400, 0);
  const vid = videoNode(0, 0);
  const osc = lfoNode(0, 400);
  const d = vid.data as { assetUrl: string; start: number; loop: boolean };
  d.assetUrl = "/assets/j/short.mp4";
  d.start = 0;
  d.loop = loop;
  let g: Graph = { ...emptyGraph(), nodes: [mg, vid, osc] };
  const slots = (mg.data as { inputs: { id: string }[] }).inputs;
  g = connectVideo(g, vid.id, "out", mg.id, slots[0].id);
  g = connect(g, osc.id, mg.id, "trigger"); // a node-bound trigger, so the cuts resolve
  return g;
}

const mount = (g: Graph) =>
  render(
    <AnimationCanvas
      segment={{ ...segment, graph: g }}
      job="j"
      assets={ASSETS}
      onGraphChange={() => {}}
    />
  );

describe("Montage — a slot short of material", () => {
  it("says the slot goes BLACK, not that it freezes", async () => {
    const { findByTitle } = mount(oneShortSlot(false));
    const badge = await findByTitle(/clip too short/i);
    expect(badge.getAttribute("title")).toMatch(/goes BLACK/);
    // The old wording promised something harmless and was wrong after v14.
    expect(badge.getAttribute("title")).not.toMatch(/freezes on its last frame/);
    expect(badge.textContent).toContain("−6.0s");
  });

  it("says it loops instead, when the card loops — a looping slot never goes black", async () => {
    const { findByTitle } = mount(oneShortSlot(true));
    const badge = await findByTitle(/clip too short/i);
    expect(badge.getAttribute("title")).toMatch(/loops back to the in-point/);
    expect(badge.getAttribute("title")).not.toMatch(/goes BLACK/);
  });

  it("totals the black on the CARD, so it is not one badge among dozens of rows", async () => {
    const { findByText } = mount(oneShortSlot(false));
    const summary = await findByText(/1 slot short/i);
    expect(summary.textContent).toMatch(/6\.0s black/);
  });

  it("counts a looping short slot as short but NOT as black", async () => {
    const { findByText } = mount(oneShortSlot(true));
    const summary = await findByText(/1 slot short/i);
    expect(summary.textContent).toMatch(/0\.0s black/);
    expect(summary.textContent).toMatch(/\+1 looping/);
  });

  it("stays quiet when the clip covers its slot", async () => {
    const long: Asset[] = [{ ...ASSETS[0], duration: 30 }];
    const { queryByTitle } = render(
      <AnimationCanvas
        segment={{ ...segment, graph: oneShortSlot(false) }}
        job="j"
        assets={long}
        onGraphChange={() => {}}
      />
    );
    await waitFor(() => expect(queryByTitle(/clip too short/i)).toBeNull());
  });
});
