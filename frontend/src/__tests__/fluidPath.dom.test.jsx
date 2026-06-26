// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import PathEditor from "../components/fluid/PathEditor.tsx";

afterEach(cleanup);

// First coverage of the FluidLab source-path overlay (extracted to PathEditor.tsx
// in spec 02 step 2 — previously inline + untested).
describe("PathEditor", () => {
  const base = {
    points: [
      [0.5, 0.5],
      [0.2, 0.8],
      [0.8, 0.3],
    ],
    pathClosed: false,
    onAddPoint: () => {},
    onMovePoint: () => {},
    onToggleClosed: () => {},
    onRemovePoint: () => {},
  };

  it("renders one numbered marker per point", () => {
    const { container, getByText } = render(<PathEditor {...base} />);
    expect(container.querySelectorAll(".fluid-marker").length).toBe(3);
    expect(getByText("1")).toBeTruthy();
    expect(container.querySelector(".fluid-marker.first")).toBeTruthy();
  });

  it("draws a polyline when open and a polygon when closed", () => {
    const open = render(<PathEditor {...base} pathClosed={false} />);
    expect(open.container.querySelector("polyline")).toBeTruthy();
    expect(open.container.querySelector("polygon")).toBeFalsy();
    cleanup();
    const closed = render(<PathEditor {...base} pathClosed={true} />);
    expect(closed.container.querySelector("polygon")).toBeTruthy();
    expect(closed.container.querySelector("polyline")).toBeFalsy();
  });

  it("adds a point when the stage (not a marker) is clicked", () => {
    const onAddPoint = vi.fn();
    const { container } = render(<PathEditor {...base} onAddPoint={onAddPoint} />);
    const overlay = container.querySelector(".fluid-overlay");
    fireEvent.pointerDown(overlay); // target === currentTarget → an add
    expect(onAddPoint).toHaveBeenCalledTimes(1);
    expect(onAddPoint.mock.calls[0][0]).toHaveLength(2); // a [x, y] coord
  });

  it("ignores a pointer-down that lands on a marker (no stray add)", () => {
    const onAddPoint = vi.fn();
    const { container } = render(<PathEditor {...base} onAddPoint={onAddPoint} />);
    fireEvent.pointerDown(container.querySelector(".fluid-marker"));
    expect(onAddPoint).not.toHaveBeenCalled();
  });

  it("removes a point on right-click (contextmenu)", () => {
    const onRemovePoint = vi.fn();
    const { container } = render(<PathEditor {...base} onRemovePoint={onRemovePoint} />);
    const markers = container.querySelectorAll(".fluid-marker");
    fireEvent.contextMenu(markers[1]);
    expect(onRemovePoint).toHaveBeenCalledWith(1);
  });
});
