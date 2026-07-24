import { describe, it, expect } from "vitest";
import {
  emptyGraph,
  videoNode,
  textNode,
  combineNode,
  outputNode,
  connectVideo,
} from "../lib/graphModel";
import { leafVideoCard } from "../components/animation/nodes/useMontageShortfall";
import type { CombineData, Graph, VideoData } from "../lib/types";

// leafVideoCard finds the clip that bounds a montage extract — through FX cards and
// now through a COMBINE (the "video + caption" child): without the combine hop, a
// video with a text card over it lost its tile thumbnail and duration warning
// (the strip showed the generic ✦ animation placeholder — "no preview").

function comboGraph(): Graph {
  const v = videoNode(0, 0);
  (v.data as VideoData).assetUrl = "/assets/j/clip.mp4";
  (v.data as VideoData).start = 2;
  const t = textNode(0, 200);
  const cb = combineNode(200, 0);
  (cb.data as CombineData).mode = "stack";
  const out = outputNode(400, 0);
  let g: Graph = { ...emptyGraph(), nodes: [v, t, cb, out] };
  const slots = (cb.data as CombineData).inputs.map((s) => s.id);
  g = connectVideo(g, v.id, "out", cb.id, slots[0]); // bottom: the clip
  g = connectVideo(g, t.id, "out", cb.id, slots[1]); // top: the caption
  g = connectVideo(g, cb.id, "out", out.id, "video");
  return g;
}

describe("leafVideoCard", () => {
  it("resolves the clip through a combine (video + text caption)", () => {
    const clip = leafVideoCard(comboGraph());
    expect(clip).toMatchObject({ url: "/assets/j/clip.mp4", start: 2 });
  });

  it("skips non-video branches and still finds the clip in a later slot", () => {
    const g = comboGraph();
    // Swap the wiring order: caption on the FIRST slot, clip on the second —
    // the walk must skip the text branch instead of giving up.
    const cb = g.nodes.find((n) => n.type === "combine")!;
    const [s1, s2] = (cb.data as CombineData).inputs.map((s) => s.id);
    const v = g.nodes.find((n) => n.type === "video")!;
    const t = g.nodes.find((n) => n.type === "text")!;
    const swapped: Graph = {
      ...g,
      edges: g.edges.map((e) =>
        e.source === v.id && e.target === cb.id
          ? { ...e, targetPort: s2 }
          : e.source === t.id && e.target === cb.id
            ? { ...e, targetPort: s1 }
            : e
      ),
    };
    expect(leafVideoCard(swapped)?.url).toBe("/assets/j/clip.mp4");
  });

  it("still returns null when nothing video feeds the output", () => {
    const t = textNode(0, 0);
    const out = outputNode(200, 0);
    let g: Graph = { ...emptyGraph(), nodes: [t, out] };
    g = connectVideo(g, t.id, "out", out.id, "video");
    expect(leafVideoCard(g)).toBeNull();
  });
});

// The crop pad's aspect lock: a resized rect snaps to the target height-per-width
// with the corner OPPOSITE the handle anchored, inside [0,1]².
import { lockAspect } from "../components/animation/nodes/BoxPad";

describe("lockAspect", () => {
  it("re-shapes to the ratio, anchored opposite the dragged corner", () => {
    const out = lockAspect({ x: 0.1, y: 0.1, w: 0.4, h: 0.1 }, "se", 0.5);
    expect(out.x).toBeCloseTo(0.1); // nw anchor held
    expect(out.y).toBeCloseTo(0.1);
    expect(out.h).toBeCloseTo(out.w * 0.5);
  });

  it("shrinks to stay inside the frame instead of spilling", () => {
    const out = lockAspect({ x: 0.8, y: 0.8, w: 0.5, h: 0.5 }, "se", 2);
    expect(out.x + out.w).toBeLessThanOrEqual(1.0001);
    expect(out.y + out.h).toBeLessThanOrEqual(1.0001);
    expect(out.h).toBeCloseTo(out.w * 2, 5);
  });
});
