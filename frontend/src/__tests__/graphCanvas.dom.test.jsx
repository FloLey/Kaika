// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import GraphCanvas from "../components/animation/GraphCanvas";

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
  const renderNode = (node) => <div data-testid={`node-${node.id}`}>{node.id}</div>;
  return render(<GraphCanvas graph={graph} renderNode={renderNode} {...props} />);
}

describe("GraphCanvas interactions (jsdom)", () => {
  it("renders a card per node via renderNode", () => {
    const { getByTestId } = setup();
    expect(getByTestId("node-n1").textContent).toBe("n1");
  });

  it("Delete with a selected edge calls onEdgeDelete (the keydown stale-closure path)", () => {
    const onEdgeDelete = vi.fn();
    setup({ selected: "e1", onEdgeDelete });
    fireEvent.keyDown(window, { key: "Delete" });
    expect(onEdgeDelete).toHaveBeenCalledTimes(1);
    expect(onEdgeDelete.mock.calls[0][0].id).toBe("e1");
  });

  it("Delete with a selected node calls onNodeDelete", () => {
    const onNodeDelete = vi.fn();
    setup({ selected: "n1", onNodeDelete });
    fireEvent.keyDown(window, { key: "Delete" });
    expect(onNodeDelete).toHaveBeenCalledTimes(1);
    expect(onNodeDelete.mock.calls[0][0].id).toBe("n1");
  });

  it("does NOT delete while typing in an input field", () => {
    const onEdgeDelete = vi.fn();
    const { container } = setup({ selected: "e1", onEdgeDelete });
    const input = document.createElement("input");
    container.appendChild(input);
    fireEvent.keyDown(input, { key: "Delete" });   // bubbles to the window handler
    expect(onEdgeDelete).not.toHaveBeenCalled();
  });
});
