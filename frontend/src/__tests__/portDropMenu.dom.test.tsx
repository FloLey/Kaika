// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import PortDropMenu from "../components/animation/PortDropMenu";
import type { DropCandidate } from "../components/animation/dropPlan";

// The port picker a dropped wire opens. Its contract: every legal input is offered,
// parking stays reachable as an explicit choice, and the keyboard can drive all of
// it — the drag ends with the cursor already there, so reaching for the mouse again
// is the thing to avoid.

const cand = (
  portId: string,
  label: string,
  extra: Partial<DropCandidate> = {}
): DropCandidate => ({
  portId,
  label,
  currentSource: null,
  ...extra,
});

function setup(props: Partial<React.ComponentProps<typeof PortDropMenu>> = {}) {
  const onPick = vi.fn();
  const onPark = vi.fn();
  const onCancel = vi.fn();
  const onAddDynamic = vi.fn();
  const utils = render(
    <PortDropMenu
      x={40}
      y={60}
      sourceName="bass pulse"
      targetName="fluid 1"
      candidates={[cand("force", "force"), cand("radius", "radius")]}
      nameOf={(id) => `card ${id}`}
      onPick={onPick}
      onPark={onPark}
      onCancel={onCancel}
      onAddDynamic={onAddDynamic}
      {...props}
    />
  );
  return { ...utils, onPick, onPark, onCancel, onAddDynamic };
}

describe("PortDropMenu", () => {
  it("names both ends of the wire and offers every candidate", () => {
    const { getByText, getAllByRole } = setup();
    expect(getByText("bass pulse")).toBeTruthy();
    expect(getByText("fluid 1")).toBeTruthy();
    // two candidates + "park for later"
    expect(getAllByRole("button")).toHaveLength(3);
  });

  it("clicking a row assigns that port", () => {
    const { getByText, onPick } = setup();
    fireEvent.click(getByText("radius"));
    expect(onPick).toHaveBeenCalledWith("radius");
  });

  it("keeps parking reachable — the old behaviour is a choice, not the fallback", () => {
    const { getByText, onPark } = setup();
    fireEvent.click(getByText("park for later"));
    expect(onPark).toHaveBeenCalledTimes(1);
  });

  it("says what a pick would replace on an occupied port", () => {
    const { getByText } = setup({
      candidates: [cand("force", "force", { currentSource: "n7" })],
    });
    expect(getByText("replaces card n7")).toBeTruthy();
  });

  it("arrow keys walk the rows and Enter takes the highlighted one", () => {
    const { container, onPick } = setup();
    const root = container.querySelector(".gc-drop-menu") as HTMLElement;
    fireEvent.keyDown(root, { key: "ArrowDown" }); // row 0 -> row 1
    fireEvent.keyDown(root, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("radius");
  });

  it("Enter on the last row parks; the ring wraps back to the top", () => {
    const { container, onPark, onPick } = setup();
    const root = container.querySelector(".gc-drop-menu") as HTMLElement;
    fireEvent.keyDown(root, { key: "ArrowUp" }); // wraps to the park row
    fireEvent.keyDown(root, { key: "Enter" });
    expect(onPark).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("Escape cancels the drop outright", () => {
    const { container, onCancel, onPark } = setup();
    const root = container.querySelector(".gc-drop-menu") as HTMLElement;
    fireEvent.keyDown(root, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onPark).not.toHaveBeenCalled(); // cancel ≠ park
  });

  it("a pointer outside cancels", () => {
    const { onCancel } = setup();
    fireEvent.pointerDown(document.body);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("offers to grow a dynamic group so a full combine is not a dead end", () => {
    const { getByText, onAddDynamic } = setup({ dynamicLabel: "layer" });
    fireEvent.click(getByText("+ new layer"));
    expect(onAddDynamic).toHaveBeenCalledTimes(1);
  });

  it("filters a long list, and groups it under its param headers", () => {
    const many = [
      cand("force", "force", { group: "source" }),
      cand("radius", "radius", { group: "source" }),
      cand("viscosity", "viscosity", { group: "medium" }),
      ...Array.from({ length: 6 }, (_, i) => cand(`p${i}`, `param ${i}`, { group: "medium" })),
    ];
    const { container, getByLabelText, queryByText } = setup({ candidates: many });
    expect(container.querySelectorAll(".gc-drop-group")).toHaveLength(2); // source, medium
    fireEvent.change(getByLabelText("filter inputs"), { target: { value: "visc" } });
    expect(queryByText("viscosity")).toBeTruthy();
    expect(queryByText("force")).toBeNull();
  });

  it("says so when the filter matches nothing, instead of an empty box", () => {
    const many = Array.from({ length: 9 }, (_, i) => cand(`p${i}`, `param ${i}`));
    const { getByLabelText, getByText } = setup({ candidates: many });
    fireEvent.change(getByLabelText("filter inputs"), { target: { value: "zzz" } });
    expect(getByText("no input matches")).toBeTruthy();
  });
});
