// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
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
});
