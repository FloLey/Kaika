// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import GraphCanvas from "../components/animation/GraphCanvas";
import type { Graph, GraphNode } from "../lib/types";

afterEach(cleanup);

// A trivial node-agnostic graph + renderNode so we exercise GraphCanvas itself
// (selection + keyboard delete) without any signal/fluid specifics.
function setup(props = {}) {
  const graph = {
    version: 2,
    nodes: [{ id: "n1", type: "x", x: 0, y: 0, data: {} }],
    edges: [{ id: "e1", source: "n1", sourcePort: "out", target: "n1", targetPort: "in" }],
    view: { tx: 0, ty: 0, scale: 1 },
  };
  const renderNode = (node: GraphNode) => <div data-testid={`node-${node.id}`}>{node.id}</div>;
  return render(
    <GraphCanvas graph={graph as unknown as Graph} renderNode={renderNode} {...props} />
  );
}

describe("GraphCanvas interactions (jsdom)", () => {
  it("renders a card per node via renderNode", () => {
    const { getByTestId } = setup();
    expect(getByTestId("node-n1").textContent).toBe("n1");
  });

  it("Delete with a selection calls onDeleteSelection with the selected ids", () => {
    const onDeleteSelection = vi.fn();
    setup({ selected: new Set(["e1"]), onDeleteSelection });
    fireEvent.keyDown(window, { key: "Delete" });
    expect(onDeleteSelection).toHaveBeenCalledTimes(1);
    expect(onDeleteSelection.mock.calls[0][0]).toEqual(["e1"]);
  });

  it("Delete with several selected nodes passes them all in one go", () => {
    const onDeleteSelection = vi.fn();
    setup({ selected: new Set(["n1", "e1"]), onDeleteSelection });
    fireEvent.keyDown(window, { key: "Delete" });
    expect(onDeleteSelection).toHaveBeenCalledTimes(1);
    expect(new Set(onDeleteSelection.mock.calls[0][0])).toEqual(new Set(["n1", "e1"]));
  });

  it("does NOT delete while typing in an input field", () => {
    const onDeleteSelection = vi.fn();
    const { container } = setup({ selected: new Set(["e1"]), onDeleteSelection });
    const input = document.createElement("input");
    container.appendChild(input);
    fireEvent.keyDown(input, { key: "Delete" }); // bubbles to the window handler
    expect(onDeleteSelection).not.toHaveBeenCalled();
  });

  it("drag is local (no commit per move); positions commit ONCE on pointer-up", () => {
    const onGraphChange = vi.fn();
    const graph = {
      version: 2,
      nodes: [{ id: "n1", type: "x", x: 5, y: 5, data: {} }],
      edges: [],
      view: { tx: 0, ty: 0, scale: 1 },
    };
    const renderNode = (node: GraphNode, helpers: { onTitlePointerDown: (e: unknown) => void }) => (
      <div data-testid={`node-${node.id}`} onPointerDown={helpers.onTitlePointerDown}>
        {node.id}
      </div>
    );
    const { getByTestId } = render(
      <GraphCanvas
        graph={graph as unknown as Graph}
        renderNode={renderNode as never}
        onGraphChange={onGraphChange}
      />
    );
    // jsdom has no full PointerEvent: dispatch raw events with coords attached
    // (same pattern as boxPad.dom.test).
    act(() => {
      getByTestId("node-n1").dispatchEvent(
        Object.assign(new Event("pointerdown", { bubbles: true }), {
          button: 0,
          clientX: 10,
          clientY: 10,
        })
      );
    });
    act(() => {
      window.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 30, clientY: 25 }));
      window.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 40, clientY: 35 }));
    });
    expect(onGraphChange).not.toHaveBeenCalled(); // dragging never commits the graph
    act(() => {
      window.dispatchEvent(new Event("pointerup"));
    });
    expect(onGraphChange).toHaveBeenCalledTimes(1); // one commit on release
    const updater = onGraphChange.mock.calls[0][0];
    const next = updater(graph);
    expect(next.nodes[0]).toMatchObject({ x: 35, y: 30 }); // 5 + (40-10), 5 + (35-10)
  });

  it("a plain click (no movement) commits nothing", () => {
    const onGraphChange = vi.fn();
    const { getByTestId } = setup({ onGraphChange });
    fireEvent.pointerDown(getByTestId("node-n1"), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(window);
    expect(onGraphChange).not.toHaveBeenCalled();
  });
});
