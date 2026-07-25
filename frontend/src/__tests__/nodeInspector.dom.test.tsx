// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { useState } from "react";
import AnimationCanvas from "../components/animation/AnimationCanvas";
import NodeInspector from "../components/animation/NodeInspector";
import { fluidNode, gateNode, lfoNode } from "../lib/graphModel";
import type { Graph, GraphNode, Segment } from "../lib/types";
import type { NodeCtx } from "../components/animation/nodes/nodeProps";

// The inspector, docked instead of modal. The contract: it is the SAME panel (so
// comparing the two arrangements is about the arrangement), the graph stays visible
// while you edit, and moving between cards swaps it with no open/close cycle.

vi.mock("../lib/api", async (orig) => ({
  ...(await orig<typeof import("../lib/api")>()),
  startStreamRender: vi.fn(() => new Promise(() => {})), // never resolves: no render
  resolveCurve: vi.fn(() => new Promise(() => {})),
}));

const segment: Segment = { id: "s1", label: "VERSE", start: 0, end: 8, signals: [] };
const setSearch = (s: string) => window.history.replaceState(null, "", s);
beforeEach(() => setSearch("/?ui=next"));
afterEach(() => setSearch("/"));

const g = (nodes: GraphNode[] = []): Graph => ({ version: 1, nodes, edges: [] });

function Host({ initial }: { initial: Graph }) {
  const [graph, setGraph] = useState(initial);
  return <AnimationCanvas segment={segment} graph={graph} onGraphChange={setGraph} />;
}

// Select a card the way the compact body does: jsdom has no PointerEvent, so
// dispatch a native carrying `button`.
const clickBody = (container: HTMLElement, id: string) =>
  fireEvent.click(container.querySelector(`[data-node-id="${id}"] .anim-compact-body`)!);

const dock = () => document.querySelector(".anim-dock");
const panelName = () => document.querySelector(".anim-dock .node-settings-name")?.textContent;

describe("the docked inspector", () => {
  it("is not there without the flag — the modal is", () => {
    setSearch("/");
    const { container } = render(<Host initial={g([fluidNode(0, 0)])} />);
    expect(dock()).toBeNull();
    expect(container.querySelector(".anim-stage-docked")).toBeNull();
  });

  it("says what to do when nothing is selected", () => {
    render(<Host initial={g([fluidNode(0, 0)])} />);
    expect(dock()?.textContent).toContain("select a card");
  });

  it("clicking a card's body shows it in the dock — no modal opens", () => {
    const fluid = { ...fluidNode(0, 0), name: "smoke" };
    const { container } = render(<Host initial={g([fluid])} />);
    act(() => {
      clickBody(container, fluid.id);
    });
    expect(panelName()).toBe("smoke");
    // The modal path is what the dock replaces.
    expect(document.querySelector(".anim-modal-scrim")).toBeNull();
    // …and the graph it edits is still on screen.
    expect(container.querySelector(`[data-node-id="${fluid.id}"]`)).toBeTruthy();
  });

  it("moving to another card swaps the panel rather than closing and reopening", () => {
    const a = { ...fluidNode(0, 0), name: "smoke" };
    const b = { ...gateNode(300, 0), name: "kick gate" };
    const { container } = render(<Host initial={g([a, b])} />);
    act(() => {
      clickBody(container, a.id);
    });
    expect(panelName()).toBe("smoke");
    act(() => {
      clickBody(container, b.id);
    });
    expect(panelName()).toBe("kick gate");
    expect(document.querySelectorAll(".anim-dock .node-settings-name")).toHaveLength(1);
  });

  it("with several cards selected it names the count instead of guessing one", () => {
    const a = fluidNode(0, 0);
    const b = gateNode(300, 0);
    const { container } = render(<Host initial={g([a, b])} />);
    const head = (id: string) => container.querySelector(`[data-node-id="${id}"] .anim-node-head`)!;
    const ptr = (shift: boolean) =>
      Object.assign(new Event("pointerdown", { bubbles: true }), { button: 0, shiftKey: shift });
    act(() => {
      head(a.id).dispatchEvent(ptr(false));
    });
    act(() => {
      head(b.id).dispatchEvent(ptr(true)); // shift-click adds to the selection
    });
    expect(dock()?.textContent).toContain("2 cards selected");
  });
});

describe("NodeInspector on its own", () => {
  const ctx = { graph: g([lfoNode(0, 0)]), signals: [] } as unknown as NodeCtx;

  it("renders the same panel class in both hosts, so the shared CSS applies", () => {
    const node = lfoNode(0, 0);
    const { container } = render(
      <NodeInspector
        node={node}
        ctx={{ ...ctx, graph: g([node]) }}
        onGraphChange={() => {}}
        className="node-settings anim-dock-panel"
      />
    );
    const root = container.firstElementChild!;
    expect(root.className).toContain("node-settings");
    expect(root.className).toContain("anim-dock-panel");
  });

  it("has no close button when the host has nothing to close", () => {
    const node = lfoNode(0, 0);
    const { container, rerender } = render(
      <NodeInspector
        node={node}
        ctx={{ ...ctx, graph: g([node]) }}
        onGraphChange={() => {}}
        className="node-settings"
      />
    );
    expect(container.querySelector(".node-settings-close")).toBeNull();
    const onClose = vi.fn();
    rerender(
      <NodeInspector
        node={node}
        ctx={{ ...ctx, graph: g([node]) }}
        onGraphChange={() => {}}
        onClose={onClose}
        className="node-settings"
      />
    );
    fireEvent.click(container.querySelector(".node-settings-close")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renames the card from its header", () => {
    const node = { ...lfoNode(0, 0), name: "wobble" };
    const onGraphChange = vi.fn();
    const { container } = render(
      <NodeInspector
        node={node}
        ctx={{ ...ctx, graph: g([node]) }}
        onGraphChange={onGraphChange}
        className="node-settings"
      />
    );
    fireEvent.doubleClick(container.querySelector(".node-settings-name")!);
    const input = container.querySelector(".node-settings-name-edit") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "slow wobble" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onGraphChange).toHaveBeenCalledTimes(1);
    const next = onGraphChange.mock.calls[0][0](g([node]));
    expect(next.nodes[0].name).toBe("slow wobble");
  });
});
