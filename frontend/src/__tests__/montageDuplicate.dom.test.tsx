// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import AnimationCanvas from "../components/animation/AnimationCanvas";
import { emptyGraph, montageNode, videoNode, connectVideo } from "../lib/graphModel";
import type { Graph, Segment } from "../lib/types";

// Two montage slots fed by the SAME clip replay the same footage; from the same
// in-point they are frame-identical, which on screen looks like the video looping
// instead of cutting. It played wrong and silently — the shortfall warning only ever
// watched clip LENGTH. These pin that the card now says so, via the header roll-up that
// rides the compact card (the montage's per-row list is settings-modal only).

vi.mock("../lib/api", async (orig) => ({
  ...(await orig<typeof import("../lib/api")>()),
  startStreamRender: vi.fn(() => new Promise(() => {})),
  resolveCurve: vi.fn(() => new Promise(() => {})),
}));

const segment: Segment = { id: "s1", label: "chorus", start: 0, end: 8, signals: [] };

function twoSlots(urls: [string, string], starts: [number, number]): Graph {
  const mg = montageNode(400, 0);
  const a = videoNode(0, 0);
  const b = videoNode(0, 300);
  (a.data as { assetUrl: string; start: number }).assetUrl = urls[0];
  (a.data as { assetUrl: string; start: number }).start = starts[0];
  (b.data as { assetUrl: string; start: number }).assetUrl = urls[1];
  (b.data as { assetUrl: string; start: number }).start = starts[1];
  let g: Graph = { ...emptyGraph(), nodes: [mg, a, b] };
  const slots = (mg.data as { inputs: { id: string }[] }).inputs;
  g = connectVideo(g, a.id, "out", mg.id, slots[0].id);
  g = connectVideo(g, b.id, "out", mg.id, slots[1].id);
  return g;
}

const mount = (g: Graph) =>
  render(<AnimationCanvas segment={segment} graph={g} onGraphChange={() => {}} />);

describe("Montage — a clip used by two slots is flagged", () => {
  it("rolls up the repeat, naming the slot it duplicates, when the frames are identical", () => {
    const { getByText } = mount(twoSlots(["/assets/j/same.mp4", "/assets/j/same.mp4"], [0, 0]));
    const badge = getByText(/1 repeat/i);
    const span = badge.closest("span")!;
    expect(span.getAttribute("title")).toMatch(/slot 2 = slot 1/i); // points at the row it duplicates
    expect(span.getAttribute("title")).not.toMatch(/different in-point/i); // same in-point
    expect(span.className).toContain("same"); // the loud variant (frame-identical)
  });

  it("marks it soft when the in-points differ — another moment of the same footage", () => {
    const { getByText } = mount(twoSlots(["/assets/j/same.mp4", "/assets/j/same.mp4"], [0, 4]));
    const span = getByText(/1 repeat/i).closest("span")!;
    expect(span.getAttribute("title")).toMatch(/different in-point/i);
    expect(span.className).not.toContain("same");
  });

  it("says nothing when the two slots hold different clips", () => {
    const { queryByText } = mount(twoSlots(["/assets/j/a.mp4", "/assets/j/b.mp4"], [0, 0]));
    expect(queryByText(/repeat/i)).toBeNull();
  });
});
