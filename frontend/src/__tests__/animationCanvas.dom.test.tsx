// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import AnimationCanvas from "../components/animation/AnimationCanvas";
import type { Segment } from "../lib/types";

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
