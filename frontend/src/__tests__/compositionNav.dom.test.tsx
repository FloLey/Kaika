// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import Studio from "../components/studio/Studio";
import { emptyGraph, montageNode, lfoNode, connect, addExtract } from "../lib/graphModel";
import { leafComposition } from "../lib/compositions";
import type { Composition, CompositionPool, Graph } from "../lib/types";

// The composition breadcrumb (specs/compositions step 04): "open" on a montage
// extract descends into its child composition — one composition on screen at a
// time, the transport re-windowed to the extract's slice — and every crumb is a
// click back up. Pinned through the real Studio shell, canvas included.

beforeAll(() => {
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
});

vi.mock("../lib/api", async (orig) => ({
  ...(await orig<typeof import("../lib/api")>()),
  startStreamRender: vi.fn(() => new Promise(() => {})),
  // 240 frames at 30fps over the 8s segment; one rise at frame 120 → a cut at 4s.
  resolveCurve: vi.fn(async () => ({
    curve: [...new Array(120).fill(0), ...new Array(120).fill(1)],
    fps: 30,
  })),
}));

function rig(): { root: Composition; pool: CompositionPool } {
  const clipA = leafComposition({ url: "/assets/j/a.mp4", name: "clip A", kind: "video" });
  const clipB = leafComposition({ url: "/assets/j/b.mp4", name: "clip B", kind: "video" });
  const mg = montageNode(400, 0);
  const osc = lfoNode(0, 400);
  let g: Graph = { ...emptyGraph(), nodes: [mg, osc] };
  g = addExtract(g, mg.id, clipA.id);
  g = addExtract(g, mg.id, clipB.id);
  g = connect(g, osc.id, mg.id, "trigger");
  const root: Composition = { id: "comp-root", name: "verse", graph: g };
  return { root, pool: { [root.id]: root, [clipA.id]: clipA, [clipB.id]: clipB } };
}

function renderStudio() {
  const { root, pool } = rig();
  let livePool = pool;
  const setCompositions = vi.fn((updater: (p: CompositionPool) => CompositionPool) => {
    livePool = typeof updater === "function" ? updater(livePool) : updater;
  });
  const props = {
    segments: [
      { id: "s0", label: "verse", start: 0, end: 8, signals: [], rootCompositionId: root.id },
    ],
    setSegments: vi.fn(),
    compositions: pool,
    setCompositions,
    activeSegId: "s0",
    setActiveSegId: vi.fn(),
    stems: {},
    duration: 60,
    job: "job123",
    output: {
      width: 1080,
      height: 1080,
      fps: 30,
      quality: "normal" as const,
      background: "#0b0b0f",
    },
    setOutput: vi.fn(),
    onEditSplit: vi.fn(),
  };
  return render(<Studio {...props} />);
}

describe("composition breadcrumb", () => {
  it("montage body → editor; a tile's ▸ → its child; crumbs climb back up", async () => {
    const r = renderStudio();
    fireEvent.click(r.getByText("create animation"));
    // At the root: the montage renders compact; its body opens the MONTAGE EDITOR
    // (a breadcrumb level of its own — no modal).
    fireEvent.click(r.container.querySelector(".anim-compact-body")!);
    const editor = await waitFor(() => {
      const el = r.container.querySelector(".montage-editor");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(r.getByText(/montage/, { selector: ".crumb-here" })).toBeTruthy();
    // The strip: one tile per extract (+ the trailing "+ video").
    expect(editor.querySelectorAll(".montage-tile:not(.montage-tile-add)").length).toBe(2);

    // Wait for the cut schedule (async /resolve) — only then does ▸ know the window.
    await waitFor(() => expect(editor.textContent).toMatch(/cuts\s*1×/));
    fireEvent.click(editor.querySelectorAll(".anim-extract-open")[1]);

    // Down one more level: breadcrumb names the extract + child; the canvas now
    // shows the LEAF composition (its two cards), and the transport window is the
    // extract's slice — 4s..8s, so the timeline maxes at 4.
    await waitFor(() => expect(r.getByText(/extract 2 · clip B/)).toBeTruthy());
    expect(r.container.querySelectorAll(".gc-node-pos").length).toBe(2);
    const timeline = r.container.querySelector(".seg-timeline") as HTMLInputElement;
    expect(Number(timeline.max)).toBeCloseTo(4, 5);
    // copy-to-neighbour is a segment-root affair — hidden while nested.
    expect(r.container.querySelector(".rh-copy")).toBeNull();

    // The segment crumb climbs all the way back: root canvas, full window.
    fireEvent.click(r.getByText("VERSE"));
    await waitFor(() =>
      expect(
        Number((r.container.querySelector(".seg-timeline") as HTMLInputElement).max)
      ).toBeCloseTo(8, 5)
    );
    expect(r.container.querySelector(".comp-breadcrumb")).toBeNull();
    expect(r.container.querySelector(".montage-editor")).toBeNull();
  });
});
