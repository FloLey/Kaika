// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, waitFor, fireEvent } from "@testing-library/react";
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

  it("totals the black in the ONE header line, not a second block", async () => {
    // A ⚠ badge on one row out of 37 was missed — an export shipped with black. The
    // roll-up now rides the single status line; its detail (which slots) is the title.
    const { findByTitle } = mount(oneShortSlot(false));
    const summary = await findByTitle(/short of material/i);
    expect(summary.textContent).toMatch(/6\.0s black/);
    expect(summary.getAttribute("title")).toMatch(/slot 1 \(−6\.0s\)/);
  });

  it("turns the offending ROW red when it goes black, so the list itself warns", async () => {
    const { findByTitle } = mount(oneShortSlot(false));
    const badge = await findByTitle(/clip too short/i);
    const row = badge.closest(".anim-combine-row");
    expect(row?.className).toContain("short"); // the whole line is loud, not just the badge
  });

  it("does NOT count a looping short slot as black — no header roll-up, no red row", async () => {
    const { findByTitle, queryByTitle } = mount(oneShortSlot(true));
    // Its own row still flags it (it loops, which is fine), but it is not an export defect:
    const badge = await findByTitle(/clip too short/i);
    expect(badge.getAttribute("title")).toMatch(/loops back/);
    expect(badge.closest(".anim-combine-row")?.className).not.toContain("short");
    // and it contributes 0s of black, so the header shows no black roll-up at all.
    expect(queryByTitle(/short of material/i)).toBeNull();
  });

  it("still warns about black when the montage is COLLAPSED (compact view)", async () => {
    // The bug the user actually hit: a compact montage renders CompactCard, which had only
    // a thumbnail — every warning lived in the full card. So on a busy timeline (cards
    // collapsed to fit) the "Xs black" warning was invisible, and an export shipped with a
    // black hole. The compact card must surface the same roll-up.
    const g = { ...oneShortSlot(false), viewMode: "compact" as const };
    const { findByText, queryByTitle } = mount(g);
    const warn = await findByText(/6\.0s black/);
    expect(warn.getAttribute("title")).toMatch(/goes BLACK/);
    // and it is genuinely the COMPACT card — the full per-row list is not rendered.
    expect(queryByTitle(/clip too short/i)).toBeNull();
  });

  it("a collapsed montage whose clip merely loops shows no black ribbon", async () => {
    const g = { ...oneShortSlot(true), viewMode: "compact" as const };
    const { queryByText } = render(
      <AnimationCanvas
        segment={{ ...segment, graph: g }}
        job="j"
        assets={ASSETS}
        onGraphChange={() => {}}
      />
    );
    await waitFor(() => expect(queryByText(/black/i)).toBeNull());
  });

  it("in the settings modal, the montage body does NOT re-list the slots", async () => {
    // The "2 lists" the user actually saw: opening a compact montage shows the modal's
    // INPUTS panel (a slot row per input, with a source dropdown — the only wiring that
    // WORKS there, drag being inert) AND the montage's own rich slot list. On canvas the
    // rich list is the single list; in the modal it must step aside for the INPUTS panel.
    const g = { ...oneShortSlot(false), viewMode: "compact" as const };
    const { container, findByText, getByRole } = mount(g);
    fireEvent.click(container.querySelector(".anim-compact-body")!);
    const dialog = getByRole("dialog");
    expect(dialog.querySelector(".port-connections")).toBeTruthy(); // INPUTS panel owns wiring
    expect(dialog.querySelectorAll(".anim-combine-row").length).toBe(0); // no duplicate list
    await findByText(/wired in the INPUTS panel/i); // a pointer to where they moved
    await findByText(/6\.0s black/); // the warning still shows in the header (curve is async)
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
