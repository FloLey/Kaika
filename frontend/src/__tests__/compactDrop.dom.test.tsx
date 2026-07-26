// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useGraphEditor } from "../components/animation/useGraphEditor";
import { combineNode, fluidNode, gateNode, lfoNode, isLooseEdge } from "../lib/graphModel";
import type { Graph, GraphNode, Segment } from "../lib/types";

// The compact-drop path end to end, through the real editor hook. Every card except
// `output` renders compact, so this is what a wire drag on the canvas actually does.
// The flag decides between the two behaviours, so both are pinned here.

const segment: Segment = { id: "s1", label: "VERSE", start: 0, end: 10, signals: [] };

const setSearch = (s: string) => window.history.replaceState({}, "", s);
beforeEach(() => setSearch("/"));
afterEach(() => setSearch("/"));

// Drive the hook over a graph it also owns: `commitGraph` writes back into the
// `graph` prop, which is what Studio does through the composition pool.
function editor(initial: Graph) {
  const state = { graph: initial };
  const hook = renderHook(
    ({ graph }: { graph: Graph }) =>
      useGraphEditor({
        segment,
        graph,
        commitGraph: (g) => {
          state.graph = g;
          hook.rerender({ graph: g });
        },
      }),
    { initialProps: { graph: initial } }
  );
  return { hook, state };
}

const g = (nodes: GraphNode[], edges: Graph["edges"] = []): Graph => ({
  version: 1,
  nodes,
  edges,
});
const at = { x: 120, y: 80 };

// The park-it-gray case is gone with the flag it was contrasted against: a drop can no
// longer take that path from any URL. Loose edges themselves are NOT gone — they are
// still the parked-wire representation, covered in `graphModel.test.ts`.
describe("dropping a wire on a compact card", () => {
  it("an unambiguous drop wires itself, no menu", () => {
    setSearch("/?ui=next");
    const lfo = lfoNode(0, 0);
    const gate = gateNode(200, 0);
    const { hook, state } = editor(g([lfo, gate]));
    act(() => hook.result.current.onCardDrop(lfo.id, "value", gate.id, at));
    expect(hook.result.current.dropMenu).toBeNull();
    expect(state.graph.edges).toHaveLength(1);
    expect(state.graph.edges[0]).toMatchObject({ target: gate.id, targetPort: "in" });
    expect(isLooseEdge(state.graph.edges[0])).toBe(false);
  });

  it("with the flag: an ambiguous drop opens the menu and commits NOTHING yet", () => {
    setSearch("/?ui=next");
    const lfo = lfoNode(0, 0);
    const fluid = fluidNode(200, 0);
    const { hook, state } = editor(g([lfo, fluid]));
    act(() => hook.result.current.onCardDrop(lfo.id, "value", fluid.id, at));
    const menu = hook.result.current.dropMenu;
    expect(menu).toMatchObject({ srcId: lfo.id, tgtId: fluid.id, x: 120, y: 80 });
    expect(menu!.candidates.length).toBeGreaterThan(1);
    expect(state.graph.edges).toHaveLength(0); // nothing until the user picks
  });

  it("picking a port upholds the binding↔edge invariant and closes the menu", () => {
    setSearch("/?ui=next");
    const lfo = lfoNode(0, 0);
    const fluid = fluidNode(200, 0);
    const { hook, state } = editor(g([lfo, fluid]));
    act(() => hook.result.current.onCardDrop(lfo.id, "value", fluid.id, at));
    act(() => hook.result.current.pickDropPort("force"));

    expect(hook.result.current.dropMenu).toBeNull();
    const edges = state.graph.edges.filter((e) => e.target === fluid.id);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: lfo.id, targetPort: "force" });
    // The other half of the invariant: a wired port ALSO carries the binding.
    const node = state.graph.nodes.find((n) => n.id === fluid.id) as GraphNode;
    const ports = (node.data as { ports: Record<string, { binding?: { nodeId?: string } }> }).ports;
    expect(ports.force.binding).toMatchObject({ kind: "node", nodeId: lfo.id });
  });

  it("'park for later' from the menu is the pre-flag outcome, on demand", () => {
    setSearch("/?ui=next");
    const lfo = lfoNode(0, 0);
    const fluid = fluidNode(200, 0);
    const { hook, state } = editor(g([lfo, fluid]));
    act(() => hook.result.current.onCardDrop(lfo.id, "value", fluid.id, at));
    act(() => hook.result.current.parkDrop());
    expect(hook.result.current.dropMenu).toBeNull();
    expect(state.graph.edges).toHaveLength(1);
    expect(isLooseEdge(state.graph.edges[0])).toBe(true);
  });

  it("cancelling leaves the graph untouched — no edge of any kind", () => {
    setSearch("/?ui=next");
    const lfo = lfoNode(0, 0);
    const fluid = fluidNode(200, 0);
    const { hook, state } = editor(g([lfo, fluid]));
    act(() => hook.result.current.onCardDrop(lfo.id, "value", fluid.id, at));
    act(() => hook.result.current.closeDropMenu());
    expect(hook.result.current.dropMenu).toBeNull();
    expect(state.graph.edges).toHaveLength(0);
  });

  it("'+ new layer' grows a full combine and lands the wire on the new slot", () => {
    setSearch("/?ui=next");
    const a = fluidNode(0, 0);
    const comb = combineNode(200, 0);
    const slots = comb.data.inputs.map((s) => s.id);
    let graph = g([a, comb]);
    for (const s of slots) {
      graph = {
        ...graph,
        edges: [
          ...graph.edges,
          { id: `e-${s}`, source: a.id, sourcePort: "out", target: comb.id, targetPort: s },
        ],
      };
    }
    const b = fluidNode(0, 100);
    graph = { ...graph, nodes: [...graph.nodes, b] };

    const { hook, state } = editor(graph);
    act(() => hook.result.current.onCardDrop(b.id, "video", comb.id, at));
    expect(hook.result.current.dropMenu?.dynamic?.label).toBe("layer");
    act(() => hook.result.current.addDropPort());

    const combAfter = state.graph.nodes.find((n) => n.id === comb.id) as GraphNode;
    const after = (combAfter.data as { inputs: { id: string }[] }).inputs;
    expect(after).toHaveLength(slots.length + 1);
    const fresh = after[after.length - 1].id;
    expect(state.graph.edges.some((e) => e.target === comb.id && e.targetPort === fresh)).toBe(
      true
    );
  });

  it("a drop with no coordinates parks rather than opening a menu nowhere", () => {
    // The canvas always sends a point; a caller that can't (a test stub, a future
    // headless path) must still get a defined outcome.
    setSearch("/?ui=next");
    const lfo = lfoNode(0, 0);
    const fluid = fluidNode(200, 0);
    const { hook, state } = editor(g([lfo, fluid]));
    act(() => hook.result.current.onCardDrop(lfo.id, "value", fluid.id));
    expect(hook.result.current.dropMenu).toBeNull();
    expect(state.graph.edges.filter(isLooseEdge)).toHaveLength(1);
  });
});
