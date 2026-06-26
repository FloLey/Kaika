// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import AnimationCanvas from "../components/animation/AnimationCanvas";

afterEach(cleanup);

const baseSegment = { id: "s1", start: 0, end: 8, signals: [] };

// Guards the useGraphEditor extraction end-to-end: the container mounts, the
// registry-driven palette renders, and adding a node commits the updated graph.
describe("AnimationCanvas + useGraphEditor (jsdom)", () => {
  it("renders the palette and commits a new node via the registry button", () => {
    const onGraphChange = vi.fn();
    const { getByText } = render(
      <AnimationCanvas segment={baseSegment} onGraphChange={onGraphChange} />
    );
    fireEvent.click(getByText("+ Fluid"));
    expect(onGraphChange).toHaveBeenCalledTimes(1);
    const committed = onGraphChange.mock.calls[0][0];
    expect(committed.nodes).toHaveLength(1);
    expect(committed.nodes[0].type).toBe("fluid");
  });

  it("offers a palette button for every addable node type", () => {
    const { getByText } = render(
      <AnimationCanvas segment={baseSegment} onGraphChange={() => {}} />
    );
    for (const label of ["+ Fluid", "+ Points", "+ Combine", "+ Output"]) {
      expect(getByText(label)).toBeTruthy();
    }
  });
});
