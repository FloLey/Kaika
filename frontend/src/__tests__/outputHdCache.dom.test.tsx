// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, fireEvent } from "@testing-library/react";
import AnimationCanvas from "../components/animation/AnimationCanvas";
import { emptyGraph, fluidNode, outputNode, connectVideo } from "../lib/graphModel";
import type { Graph, Segment } from "../lib/types";

// A reloaded editor has lost the in-memory render job, but the FILE is still on disk.
// The Output card asks `/export/segment/cached` and offers it, instead of launching a
// render the machine already did. This pins that the question is actually asked and
// that the answer reaches the UI — the wiring, not the backend (covered in pytest).

const findSegmentHdRender = vi.fn();
vi.mock("../lib/api", async (orig) => ({
  ...(await orig<typeof import("../lib/api")>()),
  findSegmentHdRender: (...a: unknown[]) => findSegmentHdRender(...a),
  startSegmentHdRender: vi.fn(),
  getExportStatus: vi.fn(),
  cancelExport: vi.fn(),
  startStreamRender: vi.fn(() => new Promise(() => {})), // never resolves: no draft render
  resolveCurve: vi.fn(() => new Promise(() => {})),
}));

function graphWithOutput(): Graph {
  const f = fluidNode(0, 0);
  const o = outputNode(300, 0);
  return connectVideo({ ...emptyGraph(), nodes: [f, o] }, f.id, "out", o.id, "video");
}
const segment: Segment = { id: "s1", label: "verse", start: 0, end: 8, signals: [] };

describe("Output card — an already-rendered HD is offered, not re-rendered", () => {
  beforeEach(() => {
    findSegmentHdRender.mockReset();
    sessionStorage.clear();
  });

  it("asks the lookup on mount and shows the file it reports", async () => {
    findSegmentHdRender.mockResolvedValue({ url: "/fluid/hd-abc-orig.mp4", audio: true });
    const { findByTitle } = render(
      <AnimationCanvas
        segment={{ ...segment, graph: graphWithOutput() }}
        job="deadbeef"
        onGraphChange={() => {}}
      />
    );
    await waitFor(() => expect(findSegmentHdRender).toHaveBeenCalled());
    // the body must carry what the backend hashes — graph included
    const body = findSegmentHdRender.mock.calls[0][0] as { graph: Graph; job_id: string };
    expect(body.job_id).toBe("deadbeef");
    expect(body.graph.nodes.length).toBe(2);
    const view = await findByTitle(/already rendered in HD/i);
    expect(view.textContent).toContain("✓");
    fireEvent.click(view); // opens the viewer on the cached file, no render started
  });

  it("offers nothing when the lookup reports a miss", async () => {
    findSegmentHdRender.mockResolvedValue({ url: null });
    const { queryByTitle } = render(
      <AnimationCanvas
        segment={{ ...segment, graph: graphWithOutput() }}
        job="deadbeef"
        onGraphChange={() => {}}
      />
    );
    await waitFor(() => expect(findSegmentHdRender).toHaveBeenCalled());
    expect(queryByTitle(/already rendered in HD/i)).toBeNull();
  });
});
