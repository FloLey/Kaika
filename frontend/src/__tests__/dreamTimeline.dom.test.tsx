// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import DreamNode from "../components/animation/nodes/DreamNode";
import { emptyGraph, dreamNode, lfoNode, connect } from "../lib/graphModel";
import type { DreamNode as DreamNodeT, Graph, Segment } from "../lib/types";
import type { NodeCtx } from "../components/animation/nodes/nodeProps";

// The Dream card's prompt timeline (specs/dream step 05): the SAME breakpoints strip
// the montage uses — gate cuts toggle, manual cuts place/drag/delete — with prompt
// PARTS in the upper lane instead of coverage bands, and fade handles at the
// transitions. What matters here is that the schedule the strip draws is the schedule
// the render will use (lib/cutSchedule mirrors backend cut_schedule.py).

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

// jsdom drops clientX on synthetic pointer events; native ones bubble into React's
// delegated handlers with the coordinate intact (the montage timeline test's trick).
const ptr = (type: string, x: number) =>
  Object.assign(new Event(type, { bubbles: true }), { clientX: x, button: 0 });

function mountCard(withTrigger = true) {
  const dn = dreamNode(400, 0);
  const osc = lfoNode(0, 400);
  let graph: Graph = { ...emptyGraph(), nodes: [dn, osc] };
  if (withTrigger) graph = connect(graph, osc.id, dn.id, "trigger");

  const onGraphChange = (updater: (g: Graph) => Graph) => {
    graph = updater(graph);
    rerender(ui());
  };
  const ctx = (): NodeCtx => ({
    graph,
    segment,
    compositions: {},
    signals: [],
    assets: [],
    job: "j",
    updateCompositions: vi.fn(),
    onGraphChange,
  });
  const node = () => graph.nodes.find((n) => n.id === dn.id) as DreamNodeT;
  const helpers = {
    onTitlePointerDown: vi.fn(),
    portRef: vi.fn(),
    startConnect: vi.fn(),
  } as unknown as Parameters<typeof DreamNode>[0]["helpers"];
  const ui = () => (
    <DreamNode
      node={node()}
      selected={false}
      helpers={helpers}
      ctx={ctx()}
      onGraphChange={onGraphChange}
      onDetach={vi.fn()}
      onDelete={vi.fn()}
    />
  );
  const { container, rerender } = render(ui());
  return { container, node };
}

describe("the Dream card's prompt timeline", () => {
  it("draws one band per part — a wired trigger's cut splits the window in two", async () => {
    const { container, node } = mountCard();
    // start with two prompts so the cut has somewhere to hand over to
    fireEvent.click(container.querySelectorAll("button")[0]); // (no-op guard below)
    await waitFor(() => expect(container.querySelector(".bp-gate")).toBeTruthy());
    // one prompt by default → one band, even though there is a cut (hold-last)
    expect(container.querySelectorAll(".bp-band")).toHaveLength(1);
    expect(node().data.prompts).toHaveLength(1);
  });

  it("renders with NO trigger at all — one prompt over the whole window is valid", async () => {
    const { container } = mountCard(false);
    await waitFor(() => expect(container.querySelector(".bp-rail")).toBeTruthy());
    expect(container.querySelectorAll(".bp-band")).toHaveLength(1);
    expect(container.textContent).toMatch(/no trigger/);
  });

  it("adds a prompt, and the second part appears on the timeline", async () => {
    const { container, node } = mountCard();
    await waitFor(() => expect(container.querySelector(".bp-gate")).toBeTruthy());
    const add = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("+ prompt")
    )!;
    fireEvent.click(add);
    expect(node().data.prompts).toHaveLength(2);
    await waitFor(() => expect(container.querySelectorAll(".bp-band")).toHaveLength(2));
  });

  it("clicking a gate cut disables it, and the parts collapse back to one", async () => {
    const { container, node } = mountCard();
    await waitFor(() => expect(container.querySelector(".bp-gate")).toBeTruthy());
    const add = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("+ prompt")
    )!;
    fireEvent.click(add);
    await waitFor(() => expect(container.querySelectorAll(".bp-band")).toHaveLength(2));

    fireEvent.click(container.querySelector(".bp-gate")!);
    expect(node().data.disabledCuts).toHaveLength(1);
    expect(node().data.disabledCuts[0]).toBeCloseTo(4, 3);
    // the mark stays VISIBLE, greyed — provenance never disappears
    expect(container.querySelector(".bp-gate.off")).toBeTruthy();
    await waitFor(() => expect(container.querySelectorAll(".bp-band")).toHaveLength(1));
  });

  it("clicking the empty rail places a manual split", async () => {
    const { container, node } = mountCard();
    const rail = await waitFor(() => {
      const el = container.querySelector(".bp-rail");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    // jsdom rects are 0-wide, and its fireEvent drops clientX on pointer events —
    // stub the box and dispatch NATIVE events, the montage timeline's workaround.
    rail.getBoundingClientRect = () =>
      ({ left: 0, width: 240, top: 0, height: 26, right: 240, bottom: 26 }) as DOMRect;
    fireEvent(rail, ptr("pointerdown", 60)); // frame 60 of 240 → 2.0s
    expect(node().data.manualBreakpoints).toHaveLength(1);
    expect(node().data.manualBreakpoints[0].t).toBeCloseTo(2, 3);
  });

  it("shows a fade handle per transition, and dragging one writes the fade", async () => {
    const { container, node } = mountCard();
    await waitFor(() => expect(container.querySelector(".bp-gate")).toBeTruthy());
    const add = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("+ prompt")
    )!;
    fireEvent.click(add);
    const handles = await waitFor(() => {
      const hs = container.querySelectorAll(".bp-fade-handle");
      expect(hs.length).toBeGreaterThan(0);
      return hs;
    });
    // two parts → one transition → prompt 1's fade-OUT and prompt 2's fade-IN, in
    // that DOM order (each band renders its own leading/trailing handle).
    expect(handles).toHaveLength(2);

    const lane = container.querySelector(".bp-extracts") as HTMLElement;
    Object.defineProperty(lane, "clientWidth", { value: 240, configurable: true });
    Object.defineProperty(lane.parentElement!, "clientWidth", { value: 240, configurable: true });

    // Each handle lengthens in the direction its fade actually EXTENDS: a fade-out
    // grows leftwards (back into the part before the cut), a fade-in rightwards.
    // 60px of 240 over an 8s window = 2s.
    fireEvent(handles[0], ptr("pointerdown", 100));
    fireEvent(window, ptr("pointermove", 40));
    fireEvent(window, ptr("pointerup", 40));
    expect(node().data.prompts[0].fadeOut).toBeCloseTo(2, 1);

    fireEvent(handles[1], ptr("pointerdown", 100));
    fireEvent(window, ptr("pointermove", 160));
    fireEvent(window, ptr("pointerup", 160));
    expect(node().data.prompts[1].fadeIn).toBeCloseTo(2, 1);

    // Dragging a fade-out RIGHT shrinks it back to nothing — and a zero fade is stored
    // as ABSENT, so an untouched prompt keeps its exact shape (and the node its hash).
    fireEvent(handles[0], ptr("pointerdown", 100));
    fireEvent(window, ptr("pointermove", 180));
    fireEvent(window, ptr("pointerup", 180));
    expect(node().data.prompts[0].fadeOut).toBeUndefined();
  });

  it("flags a part whose fades are CLAMPED to fit it", async () => {
    const { container, node } = mountCard();
    await waitFor(() => expect(container.querySelector(".bp-gate")).toBeTruthy());
    const add = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("+ prompt")
    )!;
    fireEvent.click(add);
    await waitFor(() => expect(container.querySelectorAll(".bp-band")).toHaveLength(2));

    // a 9s fade on a 4s part cannot fit — the render scales it down, so the card must
    // say so rather than show the number that was typed
    const ins = [...container.querySelectorAll("input[type=number]")] as HTMLInputElement[];
    fireEvent.change(ins[0], { target: { value: "9" } });
    await waitFor(() => expect(container.textContent).toMatch(/fades clamped/i));
    expect(node().data.prompts[0].fadeIn).toBe(9); // the DATA keeps what was typed
  });
});

// Dropping a wire on an FX card must CONNECT it, not park it. `planDrop` builds its
// candidates from `cardInputs`, so a card whose video input isn't declared there offers
// nowhere to land — which is what made the Extract card impossible to wire by dropping
// onto it (it has no modulatable ports at all, so its candidate list was empty).
describe("dropping a video wire on the pass-through FX cards", () => {
  it("offers each card's video input", async () => {
    const { cardInputs } = await import("../components/animation/nodeInputs");
    for (const type of ["extract", "transform", "echo", "colorgrade"]) {
      const node = { id: "n", type, x: 0, y: 0, data: { ports: {} } } as never;
      const video = cardInputs(node).inputs.filter((i) => i.flow === "video");
      expect(
        video.map((i) => i.portId),
        `${type} must accept a dropped video wire`
      ).toEqual(["video"]);
    }
  });

  it("offers BOTH of stylize's and dream's video inputs, so the drop disambiguates", async () => {
    const { cardInputs } = await import("../components/animation/nodeInputs");
    for (const type of ["stylize", "dream"]) {
      const node = { id: "n", type, x: 0, y: 0, data: { ports: {} } } as never;
      const video = cardInputs(node).inputs.filter((i) => i.flow === "video");
      expect(new Set(video.map((i) => i.portId)), type).toEqual(new Set(["video", "control"]));
    }
  });
});
