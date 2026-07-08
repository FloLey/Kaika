// @vitest-environment jsdom
import { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import AnimationCanvas from "../components/animation/AnimationCanvas";
import type { Graph, Segment } from "../lib/types";

afterEach(cleanup);

const baseSegment: Segment = { id: "s1", label: "seg", start: 0, end: 8, signals: [] };

// Guards the useGraphEditor extraction end-to-end: the container mounts, the
// registry-driven palette renders, and adding a node commits the updated graph.
describe("AnimationCanvas + useGraphEditor (jsdom)", () => {
  it("renders the palette and commits a new node via its category menu", () => {
    const onGraphChange = vi.fn();
    const { getByText } = render(
      <AnimationCanvas segment={baseSegment} onGraphChange={onGraphChange} />
    );
    // Fluid lives under the Generators category button.
    fireEvent.click(getByText("Generators"));
    fireEvent.click(getByText("Fluid"));
    expect(onGraphChange).toHaveBeenCalledTimes(1);
    const committed = onGraphChange.mock.calls[0][0];
    expect(committed.nodes).toHaveLength(1);
    expect(committed.nodes[0].type).toBe("fluid");
  });

  it("shows a button per category, each opening its node types", () => {
    const { getByText } = render(
      <AnimationCanvas segment={baseSegment} onGraphChange={() => {}} />
    );
    // every category is a top-level button (data-flow order)
    for (const cat of ["Sources", "Modulators", "Generators", "Compositing", "Output"]) {
      expect(getByText(cat)).toBeTruthy();
    }
    // opening a category reveals its node types
    fireEvent.click(getByText("Sources"));
    for (const label of ["Signal", "Points"]) {
      expect(getByText(label)).toBeTruthy();
    }
    fireEvent.click(getByText("Compositing"));
    expect(getByText("Combine")).toBeTruthy();
    // each item carries hover help: a what/how line + an input → output flow line
    expect(getByText(/Composes several video streams/)).toBeTruthy();
    expect(getByText("2+ video → video")).toBeTruthy();
  });
});

// Undo/redo is also bound to ⌘Z, but the toolbar buttons are the discoverable path —
// and their disabled state is the only signal that a step exists.
describe("undo/redo toolbar (jsdom)", () => {
  const undoBtn = (c: HTMLElement) => c.querySelector('button[aria-label="Undo"]') as HTMLButtonElement;
  const redoBtn = (c: HTMLElement) => c.querySelector('button[aria-label="Redo"]') as HTMLButtonElement;

  it("both buttons start disabled on a fresh graph", () => {
    const { container } = render(<AnimationCanvas segment={baseSegment} onGraphChange={() => {}} />);
    expect(undoBtn(container).disabled).toBe(true);
    expect(redoBtn(container).disabled).toBe(true);
  });

  // The graph is CONTROLLED (commits are lifted to segment.graph), so drive it the way
  // App does — a parent that feeds each commit straight back down.
  function Harness({ onCommit }: { onCommit: (g: Graph) => void }) {
    const [graph, setGraph] = useState<Graph | undefined>(undefined);
    return (
      <AnimationCanvas
        segment={{ ...baseSegment, graph } as Segment}
        onGraphChange={(g: Graph) => {
          onCommit(g);
          setGraph(g);
        }}
      />
    );
  }

  it("an edit enables undo; clicking it restores the previous graph and enables redo", () => {
    const onCommit = vi.fn();
    const { container, getByText } = render(<Harness onCommit={onCommit} />);
    fireEvent.click(getByText("Generators"));
    fireEvent.click(getByText("Fluid"));
    expect(onCommit.mock.calls[0][0].nodes).toHaveLength(1);
    expect(undoBtn(container).disabled).toBe(false);
    expect(redoBtn(container).disabled).toBe(true);

    fireEvent.click(undoBtn(container));
    expect(onCommit.mock.calls[1][0].nodes).toHaveLength(0); // back to the empty graph
    expect(undoBtn(container).disabled).toBe(true);
    expect(redoBtn(container).disabled).toBe(false);

    fireEvent.click(redoBtn(container));
    expect(onCommit.mock.calls[2][0].nodes).toHaveLength(1); // the fluid is back
    expect(undoBtn(container).disabled).toBe(false);
  });
});

// v16 view modes: the canvas is globally "detailed" (default — classic full cards)
// or "compact" (name + preview + settings modal on body click); `viewOverrides`
// lists cards displayed OPPOSITE to the mode; the toolbar switch flips the mode
// and clears the overrides.
describe("view modes: detailed | compact (jsdom)", () => {
  const gateGraph = (viewMode?: "detailed" | "compact", viewOverrides: string[] = []) => ({
    version: 16,
    nodes: [{ id: "n-g", type: "gate", x: 0, y: 0, data: { threshold: 0.5, hysteresis: 0.1, invert: false } }],
    edges: [],
    ...(viewMode ? { viewMode } : {}),
    viewOverrides,
    view: { tx: 0, ty: 0, scale: 1 },
  });

  it("DETAILED is the default: full cards on canvas, no compact bodies", () => {
    const seg = { ...baseSegment, graph: gateGraph() } as Segment;
    const { container } = render(<AnimationCanvas segment={seg} onGraphChange={() => {}} />);
    expect(container.querySelector(".anim-compact-body")).toBeNull();
    expect(container.querySelectorAll('input[type="range"]').length).toBeGreaterThan(0);
  });

  it("compact mode renders compact; clicking the body opens the settings modal", () => {
    const seg = { ...baseSegment, graph: gateGraph("compact") } as Segment;
    const { container, getByRole } = render(
      <AnimationCanvas segment={seg} onGraphChange={() => {}} />
    );
    const body = container.querySelector(".anim-compact-body");
    expect(body).toBeTruthy();
    expect(container.querySelector('input[type="range"]')).toBeNull(); // no full controls on canvas
    fireEvent.click(body!);
    const dialog = getByRole("dialog"); // the settings modal (portal to body)
    expect(dialog.className).toContain("node-settings");
    expect(dialog.querySelectorAll('input[type="range"]').length).toBeGreaterThan(0); // full card inside
  });

  it("overrides display a card OPPOSITE to the mode", () => {
    // compact mode + override -> that card renders FULL
    const seg = { ...baseSegment, graph: gateGraph("compact", ["n-g"]) } as Segment;
    const { container } = render(<AnimationCanvas segment={seg} onGraphChange={() => {}} />);
    expect(container.querySelector(".anim-compact-body")).toBeNull();
    // detailed mode + override -> that card renders COMPACT
    const seg2 = { ...baseSegment, graph: gateGraph("detailed", ["n-g"]) } as Segment;
    const { container: c2 } = render(<AnimationCanvas segment={seg2} onGraphChange={() => {}} />);
    expect(c2.querySelector(".anim-compact-body")).toBeTruthy();
  });

  it("the toolbar switch commits the mode and clears overrides", () => {
    const onGraphChange = vi.fn();
    const seg = { ...baseSegment, graph: gateGraph("detailed", ["n-g"]) } as Segment;
    const { getByText } = render(<AnimationCanvas segment={seg} onGraphChange={onGraphChange} />);
    fireEvent.click(getByText("▤ compact"));
    expect(onGraphChange).toHaveBeenCalledTimes(1);
    const committed = onGraphChange.mock.calls[0][0];
    expect(committed.viewMode).toBe("compact");
    expect(committed.viewOverrides).toEqual([]); // a mode switch is a clean flip
  });
});

// v20 per-view positions: x/y is the DETAILED position, cx/cy the COMPACT one. The
// canvas renders whichever set matches the mode, and a compact drag lands on cx/cy —
// the detailed layout never moves underneath it.
describe("per-view card positions (v20, jsdom)", () => {
  const gate = (id: string, pos: { x: number; y: number; cx?: number; cy?: number }) => ({
    id,
    type: "gate",
    data: { threshold: 0.5, hysteresis: 0.1, invert: false },
    ...pos,
  });
  const twoCards = (viewMode: "detailed" | "compact") => ({
    version: 20,
    nodes: [
      gate("n-a", { x: 0, y: 0, cx: 100, cy: 50 }),
      gate("n-b", { x: 400, y: 0, cx: 160, cy: 50 }),
    ],
    edges: [],
    viewMode,
    viewOverrides: [],
    view: { tx: 0, ty: 0, scale: 1 },
  });
  const wrapperPos = (container: HTMLElement, id: string) => {
    const el = container.querySelector(`.gc-node-pos[data-node-id="${id}"]`) as HTMLElement;
    return { left: el.style.left, top: el.style.top };
  };

  it("renders cards at cx/cy in compact mode and x/y in detailed", () => {
    const seg = { ...baseSegment, graph: twoCards("compact") } as Segment;
    const { container } = render(<AnimationCanvas segment={seg} onGraphChange={() => {}} />);
    expect(wrapperPos(container, "n-a")).toEqual({ left: "100px", top: "50px" });

    const seg2 = { ...baseSegment, graph: twoCards("detailed") } as Segment;
    const { container: c2 } = render(<AnimationCanvas segment={seg2} onGraphChange={() => {}} />);
    expect(wrapperPos(c2, "n-a")).toEqual({ left: "0px", top: "0px" });
  });

  it("a compact drag commits cx/cy and leaves the detailed x/y untouched", () => {
    const onGraphChange = vi.fn();
    const seg = { ...baseSegment, graph: twoCards("compact") } as Segment;
    const { container } = render(<AnimationCanvas segment={seg} onGraphChange={onGraphChange} />);
    const head = container.querySelector('.gc-node-pos[data-node-id="n-a"] .anim-node-head')!;
    // jsdom's fireEvent drops clientX on pointer events — dispatch natives (they
    // bubble to React's delegated pointerdown; move/up hit the window listeners).
    // act() flushes the drag effect so those window listeners are attached.
    const ptr = (type: string, x: number, y: number) =>
      Object.assign(new Event(type, { bubbles: true }), { clientX: x, clientY: y, button: 0 });
    act(() => {
      head.dispatchEvent(ptr("pointerdown", 10, 10));
    });
    act(() => {
      window.dispatchEvent(ptr("pointermove", 60, 40)); // +50 / +30 at scale 1
      window.dispatchEvent(ptr("pointerup", 60, 40));
    });
    expect(onGraphChange).toHaveBeenCalledTimes(1);
    const moved = onGraphChange.mock.calls[0][0].nodes.find((n: { id: string }) => n.id === "n-a");
    expect(moved).toMatchObject({ cx: 150, cy: 80, x: 0, y: 0 }); // compact moved, detailed didn't
    const other = onGraphChange.mock.calls[0][0].nodes.find((n: { id: string }) => n.id === "n-b");
    expect(other).toMatchObject({ cx: 160, cy: 50, x: 400, y: 0 }); // untouched card kept as-is
  });

  it("✨ arrange commits one layout update for the current view", () => {
    const onGraphChange = vi.fn();
    // Two compact cards stacked on the same spot — arrange must separate them.
    const graph = twoCards("compact");
    graph.nodes[1] = gate("n-b", { x: 400, y: 0, cx: 100, cy: 50 });
    const seg = { ...baseSegment, graph } as Segment;
    const { getByText } = render(<AnimationCanvas segment={seg} onGraphChange={onGraphChange} />);
    fireEvent.click(getByText("✨ arrange"));
    expect(onGraphChange).toHaveBeenCalledTimes(1);
    const committed = onGraphChange.mock.calls[0][0];
    const a = committed.nodes.find((n: { id: string }) => n.id === "n-a");
    const b = committed.nodes.find((n: { id: string }) => n.id === "n-b");
    expect(a.cx === b.cx && a.cy === b.cy).toBe(false); // no longer stacked
    expect(a.x).toBe(0); // the OTHER view's layout is untouched
    expect(b.x).toBe(400);
  });

  it("switching to detailed de-overlaps stacked x/y (the compact-built pipeline fix)", () => {
    const onGraphChange = vi.fn();
    const graph = twoCards("compact");
    // Both cards share the same DETAILED spot (built while compact, seeded alike).
    graph.nodes = [gate("n-a", { x: 0, y: 0, cx: 0, cy: 0 }), gate("n-b", { x: 0, y: 0, cx: 300, cy: 0 })];
    const seg = { ...baseSegment, graph } as Segment;
    const { getByText } = render(<AnimationCanvas segment={seg} onGraphChange={onGraphChange} />);
    fireEvent.click(getByText("▦ detailed"));
    const committed = onGraphChange.mock.calls[0][0];
    expect(committed.viewMode).toBe("detailed");
    const a = committed.nodes.find((n: { id: string }) => n.id === "n-a");
    const b = committed.nodes.find((n: { id: string }) => n.id === "n-b");
    expect(a.x === b.x && a.y === b.y).toBe(false); // pulled apart
    expect(a.cx).toBe(0); // compact layout untouched
    expect(b.cx).toBe(300);
  });
});
