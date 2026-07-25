// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import CommandPalette from "../components/next/CommandPalette";
import type { CommandItem } from "../components/next/commandItems";
import { fluidNode } from "../lib/graphModel";

// The ⌘K overlay's contract: type to narrow, arrows + Enter to run, Escape or a
// click off it to leave. It is a way to get somewhere, so it never asks twice.

const add = (label: string): CommandItem => ({
  kind: "add",
  id: `add:${label}`,
  label,
  hint: "video",
  terms: label,
  factory: (x, y) => fluidNode(x, y),
});
const card = (label: string, nodeId: string): CommandItem => ({
  kind: "card",
  id: `card:${nodeId}`,
  label,
  hint: "Fluid",
  terms: label,
  nodeId,
});

function setup(props: Partial<React.ComponentProps<typeof CommandPalette>> = {}) {
  const onRun = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <CommandPalette
      items={[add("fluid"), add("lyrics"), card("smoke", "n1")]}
      onRun={onRun}
      onClose={onClose}
      {...props}
    />
  );
  const root = () => document.querySelector(".cmdk") as HTMLElement;
  const input = () => utils.getByLabelText("command palette search") as HTMLInputElement;
  return { ...utils, onRun, onClose, root, input };
}

describe("CommandPalette", () => {
  it("shows every item, tagged by what it does", () => {
    const { container } = setup();
    expect(container.ownerDocument.querySelectorAll(".cmdk-row")).toHaveLength(3);
    expect(document.querySelectorAll(".cmdk-kind.k-add")).toHaveLength(2);
    expect(document.querySelectorAll(".cmdk-kind.k-card")).toHaveLength(1);
  });

  it("narrows as you type", () => {
    const { input } = setup();
    fireEvent.change(input(), { target: { value: "lyr" } });
    const rows = [...document.querySelectorAll(".cmdk-row")].map((r) => r.textContent);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("lyrics");
  });

  it("Enter runs the highlighted row — the first one by default", () => {
    const { root, onRun } = setup();
    fireEvent.keyDown(root(), { key: "Enter" });
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun.mock.calls[0][0].label).toBe("fluid");
  });

  it("arrows walk the list and wrap", () => {
    const { root, onRun } = setup();
    fireEvent.keyDown(root(), { key: "ArrowDown" });
    fireEvent.keyDown(root(), { key: "ArrowDown" });
    fireEvent.keyDown(root(), { key: "Enter" });
    expect(onRun.mock.calls[0][0].label).toBe("smoke");
  });

  it("re-typing resets the highlight, so Enter can't run something you never saw", () => {
    const { root, input, onRun } = setup();
    fireEvent.keyDown(root(), { key: "ArrowDown" }); // highlight row 1 (lyrics)
    fireEvent.change(input(), { target: { value: "smoke" } }); // list is now one row
    fireEvent.keyDown(root(), { key: "Enter" });
    expect(onRun.mock.calls[0][0].label).toBe("smoke");
  });

  it("clicking a row runs it", () => {
    const { getByText, onRun } = setup();
    fireEvent.click(getByText("smoke"));
    expect(onRun.mock.calls[0][0].nodeId).toBe("n1");
  });

  it("Escape closes; so does a click on the scrim, but not one inside the box", () => {
    const { root, onClose } = setup();
    fireEvent.keyDown(root(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(root());
    expect(onClose).toHaveBeenCalledTimes(1); // inside — still 1
    fireEvent.pointerDown(document.querySelector(".cmdk-scrim") as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("says so when nothing matches, and Enter then does nothing", () => {
    const { root, input, onRun } = setup();
    fireEvent.change(input(), { target: { value: "zzz" } });
    expect(document.querySelector(".cmdk-empty")?.textContent).toContain("zzz");
    fireEvent.keyDown(root(), { key: "Enter" });
    expect(onRun).not.toHaveBeenCalled();
  });

  it("announces the auto-wire only when there is a source to wire from", () => {
    expect(document.querySelector(".cmdk-foot")).toBeNull();
    setup({ wireHint: "from bass pulse" });
    expect(document.querySelector(".cmdk-foot")?.textContent).toContain("from bass pulse");
  });
});
