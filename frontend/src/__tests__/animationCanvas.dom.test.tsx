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
