// @vitest-environment jsdom
import { useState } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import AnimationCanvas from "../components/animation/AnimationCanvas";
import { gateNode, lfoNode } from "../lib/graphModel";
import type { Graph, Segment } from "../lib/types";

// ⌘K wired into the real editor: the binding, what it can reach, and the one rule
// that adds a wire on your behalf. Gated by ?ui=next, so the off state is pinned too.

const segment: Segment = { id: "s1", label: "VERSE", start: 0, end: 8, signals: [] };
const other: Segment = { id: "s2", label: "CHORUS", start: 8, end: 20, signals: [] };

const setSearch = (s: string) => window.history.replaceState({}, "", s);
beforeEach(() => setSearch("/?ui=next"));
afterEach(() => setSearch("/"));

// A host that owns the graph, like Studio does through the composition pool.
function Host({ initial, onSelectSegment }: { initial: Graph; onSelectSegment?: () => void }) {
  const [graph, setGraph] = useState(initial);
  return (
    <AnimationCanvas
      segment={segment}
      graph={graph}
      segments={[segment, other]}
      onSelectSegment={onSelectSegment}
      onGraphChange={setGraph}
    />
  );
}

const g = (nodes: Graph["nodes"] = []): Graph => ({ version: 1, nodes, edges: [] });
const openK = () => fireEvent.keyDown(window, { key: "k", metaKey: true });
const search = () => document.querySelector(".cmdk-input") as HTMLInputElement;
const rows = () => [...document.querySelectorAll(".cmdk-row")];

// Select a card the way a user does: pointerdown on its title bar, which is
// GraphCanvas's selection/drag handle. jsdom has no PointerEvent, so fireEvent
// drops `button` and the handler's `e.button !== 0` guard rejects it — dispatch a
// native carrying the field, as the drag tests already do.
const selectCard = (container: HTMLElement, id: string) =>
  container
    .querySelector(`[data-node-id="${id}"] .anim-node-head`)!
    .dispatchEvent(Object.assign(new Event("pointerdown", { bubbles: true }), { button: 0 }));

// The "does not exist without the flag" case is gone: the flag is a constant now, so
// there is no without. Keeping it would have meant mocking `isNext` false to assert an
// arm no URL can reach.
describe("⌘K in the animation editor", () => {
  it("opens on ⌘K and closes on a second press", () => {
    render(<Host initial={g()} />);
    openK();
    expect(document.querySelector(".cmdk")).toBeTruthy();
    openK();
    expect(document.querySelector(".cmdk")).toBeNull();
  });

  it("adds a card by name — no category browsing", () => {
    const { container } = render(<Host initial={g()} />);
    openK();
    fireEvent.change(search(), { target: { value: "lyrics" } });
    act(() => {
      fireEvent.click(rows()[0]);
    });
    expect(document.querySelector(".cmdk")).toBeNull(); // running closes it
    expect(container.querySelectorAll("[data-node-id]")).toHaveLength(1);
  });

  it("jumps to another segment", () => {
    const onSelectSegment = vi.fn();
    render(<Host initial={g()} onSelectSegment={onSelectSegment} />);
    openK();
    fireEvent.change(search(), { target: { value: "chorus" } });
    act(() => {
      fireEvent.click(rows()[0]);
    });
    expect(onSelectSegment).toHaveBeenCalledWith("s2");
  });

  it("finds the cards already on the canvas", () => {
    const named = { ...gateNode(0, 0), name: "kick gate" };
    render(<Host initial={g([named])} />);
    openK();
    fireEvent.change(search(), { target: { value: "kick" } });
    expect(rows()).toHaveLength(1);
    expect(rows()[0].textContent).toContain("kick gate");
  });

  it("wires a new card from the lone selected source when the port is unambiguous", () => {
    // The selection is made by clicking the card, so this also pins that the palette
    // reads the editor's real selection rather than a copy of it.
    const lfo = lfoNode(0, 0);
    const { container } = render(<Host initial={g([lfo])} />);
    act(() => {
      selectCard(container, lfo.id);
    });
    openK();
    expect(document.querySelector(".cmdk-foot")?.textContent).toContain("wires itself");
    fireEvent.change(search(), { target: { value: "gate" } });
    act(() => {
      fireEvent.click(rows()[0]);
    });
    // A gate has exactly one legal value input, so the wire lands on it.
    const edge = container.querySelector(".gc-edge");
    expect(edge).toBeTruthy();
    expect(edge!.classList.contains("unassigned")).toBe(false);
  });

  it("adds without wiring when nothing is selected", () => {
    const lfo = lfoNode(0, 0);
    const { container } = render(<Host initial={g([lfo])} />);
    openK();
    expect(document.querySelector(".cmdk-foot")).toBeNull(); // nothing to wire from
    fireEvent.change(search(), { target: { value: "gate" } });
    act(() => {
      fireEvent.click(rows()[0]);
    });
    expect(container.querySelectorAll("[data-node-id]")).toHaveLength(2);
    expect(container.querySelector(".gc-edge")).toBeNull();
  });
});
