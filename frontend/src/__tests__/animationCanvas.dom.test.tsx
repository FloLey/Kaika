// @vitest-environment jsdom
import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import AnimationCanvas from "../components/animation/AnimationCanvas";
import type { Graph, Segment } from "../lib/types";

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
  const undoBtn = (c: HTMLElement) =>
    c.querySelector('button[aria-label="Undo"]') as HTMLButtonElement;
  const redoBtn = (c: HTMLElement) =>
    c.querySelector('button[aria-label="Redo"]') as HTMLButtonElement;

  it("both buttons start disabled on a fresh graph", () => {
    const { container } = render(
      <AnimationCanvas segment={baseSegment} onGraphChange={() => {}} />
    );
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

// One view: every non-output card is compact (name + preview; body click opens the
// settings modal). Output is the exception — its body IS the render preview, so it
// always shows full. There is no detailed/compact toggle and no per-card expand.
describe("compact cards (jsdom)", () => {
  const gateGraph = () => ({
    version: 29,
    nodes: [
      {
        id: "n-g",
        type: "gate",
        x: 0,
        y: 0,
        data: { threshold: 0.5, hysteresis: 0.1, invert: false },
      },
    ],
    edges: [],
    view: { tx: 0, ty: 0, scale: 1 },
  });

  it("a non-output card renders compact, with no full controls on the canvas", () => {
    const seg = { ...baseSegment, graph: gateGraph() } as Segment;
    const { container } = render(<AnimationCanvas segment={seg} onGraphChange={() => {}} />);
    expect(container.querySelector(".anim-compact-body")).toBeTruthy();
    expect(container.querySelector('input[type="range"]')).toBeNull();
  });

  it("clicking the body opens the settings modal with the full card inside", () => {
    const seg = { ...baseSegment, graph: gateGraph() } as Segment;
    const { container, getByRole } = render(
      <AnimationCanvas segment={seg} onGraphChange={() => {}} />
    );
    fireEvent.click(container.querySelector(".anim-compact-body")!);
    const dialog = getByRole("dialog"); // the settings modal (portal to body)
    expect(dialog.className).toContain("node-settings");
    expect(dialog.querySelectorAll('input[type="range"]').length).toBeGreaterThan(0);
  });

  it("the output card is never compact — it shows its full body", () => {
    const graph = {
      version: 29,
      nodes: [{ id: "n-o", type: "output", x: 0, y: 0, data: {} }],
      edges: [],
      view: { tx: 0, ty: 0, scale: 1 },
    };
    const seg = { ...baseSegment, graph } as Segment;
    const { container } = render(<AnimationCanvas segment={seg} onGraphChange={() => {}} />);
    // no compact body for output; its render well IS its body
    expect(container.querySelector('[data-node-id="n-o"] .anim-compact-body')).toBeNull();
    expect(container.querySelector('[data-node-id="n-o"] .anim-output-well')).toBeTruthy();
  });

  it("has no detailed/compact view toggle in the toolbar", () => {
    const seg = { ...baseSegment, graph: gateGraph() } as Segment;
    const { queryByText } = render(<AnimationCanvas segment={seg} onGraphChange={() => {}} />);
    expect(queryByText("▦ detailed")).toBeNull();
    expect(queryByText("▤ compact")).toBeNull();
  });
});

// Card positions (still cx/cy this step — step 01 folds them into x/y). Every card is
// compact, so the canvas renders from cx/cy (falling back to x/y when absent) and a
// drag commits cx/cy.
describe("card positions (jsdom)", () => {
  const gate = (id: string, pos: { x: number; y: number; cx?: number; cy?: number }) => ({
    id,
    type: "gate",
    data: { threshold: 0.5, hysteresis: 0.1, invert: false },
    ...pos,
  });
  const twoCards = () => ({
    version: 29,
    nodes: [
      gate("n-a", { x: 0, y: 0, cx: 100, cy: 50 }),
      gate("n-b", { x: 400, y: 0, cx: 160, cy: 50 }),
    ],
    edges: [],
    view: { tx: 0, ty: 0, scale: 1 },
  });
  const wrapperPos = (container: HTMLElement, id: string) => {
    const el = container.querySelector(`.gc-node-pos[data-node-id="${id}"]`) as HTMLElement;
    return { left: el.style.left, top: el.style.top };
  };

  it("renders cards at their compact coords", () => {
    const seg = { ...baseSegment, graph: twoCards() } as Segment;
    const { container } = render(<AnimationCanvas segment={seg} onGraphChange={() => {}} />);
    expect(wrapperPos(container, "n-a")).toEqual({ left: "100px", top: "50px" });
  });

  it("a drag commits the position", () => {
    const onGraphChange = vi.fn();
    const seg = { ...baseSegment, graph: twoCards() } as Segment;
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
    expect(moved).toMatchObject({ cx: 150, cy: 80 }); // moved by +50/+30
  });

  it("✨ arrange commits one layout update", () => {
    const onGraphChange = vi.fn();
    // Two cards stacked on the same spot — arrange must separate them.
    const graph = twoCards();
    graph.nodes[1] = gate("n-b", { x: 400, y: 0, cx: 100, cy: 50 });
    const seg = { ...baseSegment, graph } as Segment;
    const { getByText } = render(<AnimationCanvas segment={seg} onGraphChange={onGraphChange} />);
    fireEvent.click(getByText("✨ arrange"));
    expect(onGraphChange).toHaveBeenCalledTimes(1);
    const committed = onGraphChange.mock.calls[0][0];
    const a = committed.nodes.find((n: { id: string }) => n.id === "n-a");
    const b = committed.nodes.find((n: { id: string }) => n.id === "n-b");
    expect(a.cx === b.cx && a.cy === b.cy).toBe(false); // no longer stacked
  });
});
