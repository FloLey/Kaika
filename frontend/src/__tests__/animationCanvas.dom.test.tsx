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

// v13 compact-by-default: a node NOT in graph.expanded renders the CompactCard
// (preview body + one in/out anchor); clicking its body opens the settings modal
// with the FULL card; a node in graph.expanded renders its full card on canvas.
describe("compact cards + settings modal (jsdom)", () => {
  const gateGraph = (expanded: string[]) => ({
    version: 13,
    nodes: [{ id: "n-g", type: "gate", x: 0, y: 0, data: { threshold: 0.5, hysteresis: 0.1, invert: false } }],
    edges: [],
    expanded,
    view: { tx: 0, ty: 0, scale: 1 },
  });

  it("a non-expanded node renders compact; clicking the body opens the settings modal", () => {
    const seg = { ...baseSegment, graph: gateGraph([]) } as Segment;
    const { container, getByRole } = render(
      <AnimationCanvas segment={seg} onGraphChange={() => {}} />
    );
    const body = container.querySelector(".anim-compact-body");
    expect(body).toBeTruthy(); // compact view is the default
    expect(container.querySelector('input[type="range"]')).toBeNull(); // no full controls on canvas
    fireEvent.click(body!);
    const dialog = getByRole("dialog"); // the settings modal (portal to body)
    expect(dialog.className).toContain("node-settings");
    expect(dialog.querySelectorAll('input[type="range"]').length).toBeGreaterThan(0); // full card inside
  });

  it("an expanded node renders its full card on canvas", () => {
    const seg = { ...baseSegment, graph: gateGraph(["n-g"]) } as Segment;
    const { container } = render(<AnimationCanvas segment={seg} onGraphChange={() => {}} />);
    expect(container.querySelector(".anim-compact-body")).toBeNull();
    expect(container.querySelectorAll('input[type="range"]').length).toBeGreaterThan(0);
  });
});
