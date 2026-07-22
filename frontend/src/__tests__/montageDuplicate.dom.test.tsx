// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import AnimationCanvas from "../components/animation/AnimationCanvas";
import { emptyGraph, montageNode, addExtract } from "../lib/graphModel";
import { leafComposition } from "../lib/compositions";
import type { CompositionPool, Graph, Segment } from "../lib/types";

// Two extracts playing the SAME footage replay it; from the same in-point they are
// frame-identical, which on screen looks like the video looping instead of cutting.
// It played wrong and silently — the shortfall warning only ever watched clip LENGTH.
// These pin that the card says so, via the header roll-up that rides the compact card.
// (montage-resume Part 1 lives here now: the duplicate reads through the extracts'
// LEAF compositions, so two leaves on one file are caught even as separate pool
// entries.)

vi.mock("../lib/api", async (orig) => ({
  ...(await orig<typeof import("../lib/api")>()),
  startStreamRender: vi.fn(() => new Promise(() => {})),
  resolveCurve: vi.fn(() => new Promise(() => {})),
}));

const segment: Segment = { id: "s1", label: "chorus", start: 0, end: 8, signals: [] };

function twoExtracts(
  urls: [string, string],
  starts: [number, number]
): { graph: Graph; pool: CompositionPool } {
  const mg = montageNode(400, 0);
  const pool: CompositionPool = {};
  let g: Graph = { ...emptyGraph(), nodes: [mg] };
  urls.forEach((url, i) => {
    const comp = leafComposition({ url, name: `clip ${i + 1}`, kind: "video" });
    const vid = comp.graph.nodes.find((n) => n.type === "video")!;
    (vid.data as { start: number }).start = starts[i];
    pool[comp.id] = comp;
    g = addExtract(g, mg.id, comp.id);
  });
  return { graph: g, pool };
}

const mount = (r: { graph: Graph; pool: CompositionPool }) =>
  render(
    <AnimationCanvas
      segment={segment}
      graph={r.graph}
      compositions={r.pool}
      onGraphChange={() => {}}
    />
  );

describe("Montage — footage used by two extracts is flagged", () => {
  it("rolls up the repeat, naming the extract it duplicates, when the frames are identical", () => {
    const { getByText } = mount(twoExtracts(["/assets/j/same.mp4", "/assets/j/same.mp4"], [0, 0]));
    const badge = getByText(/1 repeat/i);
    const span = badge.closest("span")!;
    expect(span.getAttribute("title")).toMatch(/extract 2 = extract 1/i); // names the row
    expect(span.getAttribute("title")).not.toMatch(/different in-point/i); // same in-point
    expect(span.className).toContain("same"); // the loud variant (frame-identical)
  });

  it("marks it soft when the in-points differ — another moment of the same footage", () => {
    const { getByText } = mount(twoExtracts(["/assets/j/same.mp4", "/assets/j/same.mp4"], [0, 4]));
    const span = getByText(/1 repeat/i).closest("span")!;
    expect(span.getAttribute("title")).toMatch(/different in-point/i);
    expect(span.className).not.toContain("same");
  });

  it("says nothing when the two extracts hold different clips", () => {
    const { queryByText } = mount(twoExtracts(["/assets/j/a.mp4", "/assets/j/b.mp4"], [0, 0]));
    expect(queryByText(/repeat/i)).toBeNull();
  });
});
