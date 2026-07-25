// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import GraphCanvas from "../components/animation/GraphCanvas";
import type { Graph, GraphNode } from "../lib/types";
import type { NodeHelpers } from "../components/animation/nodes/nodeProps";

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

// Loose edges: releasing a wire over a CARD (not a port) hands it to the editor
// via onCardDrop — the canvas only reports (src, flow, target); assigning/parking
// is the graph model's job. jsdom has no real hit-testing, so elementFromPoint is
// stubbed to the target card's wrapper (which carries data-node-id).
describe("drop-anywhere wiring (jsdom)", () => {
  it("releasing a wire over a card calls onCardDrop with the source flow", () => {
    const onCardDrop = vi.fn();
    const graph = {
      version: 14,
      nodes: [
        { id: "src", type: "x", x: 0, y: 0, data: {} },
        { id: "tgt", type: "y", x: 200, y: 0, data: {} },
      ],
      edges: [],
      view: { tx: 0, ty: 0, scale: 1 },
    };
    const renderNode = (
      node: GraphNode,
      helpers: {
        portRef: (n: string, p: string, k: string, f: string) => (el: Element | null) => void;
        startConnect: (n: string, p: string, f: string, e: unknown) => void;
      }
    ) => (
      <div data-testid={`node-${node.id}`}>
        <span
          data-testid={`out-${node.id}`}
          ref={helpers.portRef(node.id, "out", "out", "value")}
          onPointerDown={(e) => helpers.startConnect(node.id, "out", "value", e)}
        />
      </div>
    );
    const { getByTestId, container } = render(
      <GraphCanvas
        graph={graph as unknown as Graph}
        renderNode={renderNode as never}
        onCardDrop={onCardDrop}
      />
    );
    // Start a wire from src's out port…
    act(() => {
      getByTestId("out-src").dispatchEvent(
        Object.assign(new Event("pointerdown", { bubbles: true }), { clientX: 5, clientY: 5 })
      );
    });
    // …and release it over tgt's card wrapper (hit-test stubbed).
    const tgtWrapper = container.querySelector('[data-node-id="tgt"]')!;
    // jsdom doesn't implement elementFromPoint at all — install a stub directly.
    const orig = document.elementFromPoint;
    document.elementFromPoint = () => tgtWrapper;
    act(() => {
      window.dispatchEvent(Object.assign(new Event("pointerup"), { clientX: 210, clientY: 10 }));
    });
    document.elementFromPoint = orig;
    // …carrying WHERE it was released (canvas-local), so the editor can open its
    // port menu under the cursor that made the drop. jsdom's rects are all zero, so
    // the client coords pass through unchanged.
    expect(onCardDrop).toHaveBeenCalledWith("src", "value", "tgt", { x: 210, y: 10 });
  });
});

// ---------------------------------------------------------------------------
// The zoom limit does not re-measure every card on every wheel tick
// ---------------------------------------------------------------------------
// `getMinScale` -> `measureBBox` reads offsetWidth + offsetHeight PER CARD, which is
// forced synchronous layout, and it ran on every wheel event. This counts the reads
// rather than timing them: jsdom reports 0 for offsetWidth and cannot price a layout
// flush, but "how many reads happen" is the structural claim, and it is the one that
// scales with card count and trackpad event rate.
describe("GraphCanvas zoom limit (layout-read count)", () => {
  function countingSetup(nodeCount: number) {
    let reads = 0;
    for (const prop of ["offsetWidth", "offsetHeight"]) {
      Object.defineProperty(HTMLElement.prototype, prop, {
        configurable: true,
        get() {
          reads++;
          return 230;
        },
      });
    }
    const graph = {
      version: 2,
      nodes: Array.from({ length: nodeCount }, (_, i) => ({
        id: `n${i}`,
        type: "x",
        x: i * 50,
        y: i * 30,
        data: {},
      })),
      edges: [],
      view: { tx: 0, ty: 0, scale: 1 },
    };
    const renderNode = (node: GraphNode) => <div data-testid={`node-${node.id}`}>{node.id}</div>;
    const utils = render(<GraphCanvas graph={graph as unknown as Graph} renderNode={renderNode} />);
    return { ...utils, reads: () => reads, reset: () => (reads = 0) };
  }

  it("measures once for a burst of wheel ticks, not once per tick", () => {
    const { container, reads, reset } = countingSetup(20);
    const root = container.firstElementChild as HTMLElement;
    // a real container, else getMinScale short-circuits on the <40px guard
    root.getBoundingClientRect = () =>
      ({ width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600 }) as DOMRect;

    reset();
    for (let i = 0; i < 10; i++) {
      act(() => {
        fireEvent.wheel(root, { deltaY: -100, ctrlKey: true, clientX: 400, clientY: 300 });
      });
    }
    const after = reads();
    // 20 cards x 2 properties = 40 reads for ONE measurement. Per-tick would be 400.
    expect(after).toBeLessThanOrEqual(40 * 2); // one measure, plus slack for a re-render
    expect(after).toBeLessThan(400);
  });
});

// ---------------------------------------------------------------------------
// What a background pan costs, in renders
// ---------------------------------------------------------------------------
// usePanZoom calls setView on every pointermove, and GraphCanvas's layout effect has
// `view` in its deps and calls tick() — so a single move can commit twice, with the edge
// geometry rebuilt in the render body each time. Node DRAGGING was deliberately moved off
// this pattern (ref + tick, "no graph commit while dragging"); panning never was.
//
// Counted, not timed: jsdom cannot price a React commit or a layout flush. The count is
// the structural claim, and it is what a fix would change.
describe("GraphCanvas pan (render count)", () => {
  it("records how many card renders one pointermove costs", () => {
    let renders = 0;
    const graph = {
      version: 2,
      nodes: Array.from({ length: 12 }, (_, i) => ({
        id: `n${i}`,
        type: "x",
        x: i * 50,
        y: i * 30,
        data: {},
      })),
      edges: Array.from({ length: 11 }, (_, i) => ({
        id: `e${i}`,
        source: `n${i}`,
        sourcePort: "out",
        target: `n${i + 1}`,
        targetPort: "in",
      })),
      view: { tx: 0, ty: 0, scale: 1 },
    };
    // Registers real ports via helpers.portRef, so the edge-geometry map actually runs.
    // Without this the map short-circuits on `!a || !b` BEFORE reading any rect, and the
    // measurement silently reports zero for everything.
    const renderNode = (node: GraphNode, helpers: NodeHelpers) => {
      renders++;
      return (
        <div data-testid={`node-${node.id}`}>
          <span ref={helpers.portRef(node.id, "out", "out", "video")} />
          <span ref={helpers.portRef(node.id, "in", "in", "video")} />
        </div>
      );
    };
    const { container } = render(
      <GraphCanvas graph={graph as unknown as Graph} renderNode={renderNode} />
    );
    const root = container.firstElementChild as HTMLElement;
    root.setPointerCapture = () => {};
    root.releasePointerCapture = () => {};
    // the edge map calls this; count the forced layout reads a pan actually causes
    let rects = 0;
    root.getBoundingClientRect = () => {
      rects++;
      return { width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600 } as DOMRect;
    };

    act(() => {
      fireEvent.pointerDown(root, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    });
    const perMove: number[] = [];
    const rectsPerMove: number[] = [];
    for (let i = 1; i <= 5; i++) {
      renders = 0;
      rects = 0;
      act(() => {
        fireEvent.pointerMove(root, { clientX: 100 + i * 20, clientY: 100, pointerId: 1 });
      });
      perMove.push(renders);
      rectsPerMove.push(rects);
    }
    console.log(`  [pan] renderNode calls per pointermove (12 cards): ${perMove.join(", ")}`);
    console.log(
      `  [pan] root.getBoundingClientRect per pointermove (11 edges): ${rectsPerMove.join(", ")}`
    );
    expect(perMove.every((n) => n === perMove[0])).toBe(true);
    // Cards do not re-render on a pan — NodeCard's memo holds, as its comment claims.
    expect(perMove[0]).toBe(0);
    // The container rect is read once per RENDER, not once per edge. It was 22 here
    // (11 edges x 2 renders); the ceiling is deliberately per-render so adding an edge
    // cannot quietly reintroduce the per-edge form.
    expect(rectsPerMove.every((n) => n <= 4)).toBe(true);
  });
});
