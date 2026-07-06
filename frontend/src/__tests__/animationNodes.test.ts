import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

import SignalNode from "../components/animation/nodes/SignalNode";
import FluidNode from "../components/animation/nodes/FluidNode";
import OutputNode from "../components/animation/nodes/OutputNode";
import CombineNode from "../components/animation/nodes/CombineNode";
import PointsNode from "../components/animation/nodes/PointsNode";
import CompactCard from "../components/animation/nodes/CompactCard";
import { Port } from "../components/animation/nodes/NodeFrame";
import { signalNode, fluidNode, outputNode, combineNode, pointsNode } from "../lib/graphModel";
import { FLUID_PARAMS } from "../lib/fluidParams.js";
import {
  clampRangeEdit,
  setConstValue,
  setNodeRange,
  patchStatic,
} from "../components/animation/nodes/fluidBindings";
import { MinimizeContext } from "../components/animation/nodes/minimizeContext";
import type { FluidData, Graph, GraphNode, Segment, Signal } from "../lib/types";
import type { NodeHelpers, NodeProps } from "../components/animation/nodes/nodeProps";

const baseHelpers: NodeHelpers = {
  portRef: () => () => {},
  startConnect: () => {},
  onTitlePointerDown: () => {},
  selected: false,
};
// A full, valid NodeProps; callers spread it and override ctx / handlers.
const h = (node: GraphNode): NodeProps => ({
  node,
  selected: false,
  helpers: baseHelpers,
  ctx: {},
  onGraphChange: () => {},
});
// A minimal valid Segment fixture.
const seg = (start: number, end: number, signals: Signal[] = []): Segment => ({
  id: "seg",
  label: "seg",
  start,
  end,
  signals,
});

describe("Port", () => {
  it("renders data-node/data-port attributes and a kind+flow class", () => {
    const html = renderToStaticMarkup(
      React.createElement(Port, {
        nodeId: "n-1",
        portId: "force",
        kind: "in",
        flow: "value",
        portRef: () => () => {},
      })
    );
    expect(html).toContain('data-node="n-1"');
    expect(html).toContain('data-port="force"');
    expect(html).toContain("gc-port-in");
    expect(html).toContain("gc-port-value");
  });
});

describe("SignalNode", () => {
  const signal = {
    id: "sig-1",
    name: "kick",
    stemKey: "drums",
    minHz: 40,
    maxHz: 120,
    feature: "energy",
    attack: 5,
    release: 250,
    invert: false,
    gamma: 1,
    gain: 1,
    offset: 0,
    threshold: 0,
  };

  it("mirrors the resolved signal (stem / feature / band) with one out port", () => {
    const node = signalNode(signal, 0, 0);
    const html = renderToStaticMarkup(
      React.createElement(SignalNode, {
        ...h(node),
        ctx: { signals: [signal], segment: seg(0, 8), job: { job_id: "job" } },
      })
    );
    expect(html).toContain("signal"); // title
    expect(html).toContain("DRUMS"); // stem chip
    expect(html).toContain("energy"); // feature
    expect(html).toContain('data-port="out"');
  });

  it("shows a missing-signal state when the id no longer resolves", () => {
    const node = signalNode(signal, 0, 0);
    const html = renderToStaticMarkup(
      React.createElement(SignalNode, {
        ...h(node),
        ctx: { signals: [], segment: seg(0, 8), job: { job_id: "job" } },
      })
    );
    expect(html).toContain("missing signal");
    expect(html).toContain('data-port="out"'); // still wirable / deletable
  });
});

describe("OutputNode", () => {
  // A graph where `out` is wired to a fluid (so the output is renderable).
  const renderableCtx = (out: GraphNode) => {
    const fluid = fluidNode(0, 0);
    const graph = {
      version: 1,
      nodes: [fluid, out],
      edges: [
        { id: "e", source: fluid.id, sourcePort: "out", target: out.id, targetPort: "video" },
      ],
    };
    return { graph, segment: seg(0, 8), job: "job", signals: [] };
  };

  it("has one video in port and prompts to wire a fluid when unwired", () => {
    const node = outputNode(0, 0);
    const html = renderToStaticMarkup(React.createElement(OutputNode, { ...h(node), ctx: {} }));
    expect(html).toContain("output");
    expect(html).toContain('data-port="video"');
    expect(html).toContain("gc-port-in");
    // No fluid wired into this output yet.
    expect(html).toContain("wire a fluid");
  });

  it("shows the not-rendered state once a fluid is wired in", () => {
    const node = outputNode(0, 0);
    const html = renderToStaticMarkup(
      React.createElement(OutputNode, { ...h(node), ctx: renderableCtx(node) })
    );
    // Initial static render (before the async render effect runs).
    expect(html).toContain("not rendered yet");
  });
});

describe("FluidNode", () => {
  it("renders a video out port, static controls, and an in port per source param", () => {
    const node = fluidNode(0, 0);
    const html = renderToStaticMarkup(
      React.createElement(FluidNode, {
        ...h(node),
        ctx: { graph: { version: 1, nodes: [node], edges: [] } },
        onGraphChange: () => {},
        onDetach: () => {},
      })
    );
    // one out video port
    expect(html).toContain('data-port="out"');
    expect(html).toContain("gc-port-video");
    // static controls
    expect(html).toContain("enabled");
    // group headers (COLOR was extracted into the standalone color card)
    expect(html).toContain("SOURCE");
    expect(html).toContain("MEDIUM");
    // the dye-colour input (wire a color card here)
    expect(html).toContain('data-port="color"');
    // the source group is open by default -> its param in-ports are present
    const sourceKeys = FLUID_PARAMS.filter((p) => p.group === "source").map((p) => p.key);
    for (const k of sourceKeys) {
      expect(html).toContain(`data-port="${k}"`);
    }
  });

  it("a const param row's slider change yields an updater writing the binding value", () => {
    // The FluidNode const row calls setConstValue(node.id, key, v) — the exact
    // builder the component uses — and hands the resulting updater to onGraphChange.
    const node = fluidNode(0, 0);
    const param = FLUID_PARAMS.find((p) => p.key === "force");
    const updater = setConstValue(node.id, "force", param!.max);
    const g2 = updater({ version: 1, nodes: [node], edges: [] });
    expect((g2.nodes[0].data as FluidData).ports.force.binding).toEqual({
      kind: "const",
      value: param!.max,
    });
  });

  it("a wired param row's range edit patches lo/hi on the node binding", () => {
    const node = fluidNode(0, 0);
    node.data.ports.force.binding = { kind: "node", nodeId: "n-src", lo: 0, hi: 60 };
    const updater = setNodeRange(node.id, "force", 0, 45);
    const g2 = updater({ version: 1, nodes: [node], edges: [] });
    expect((g2.nodes[0].data as FluidData).ports.force.binding).toMatchObject({
      kind: "node",
      nodeId: "n-src",
      lo: 0,
      hi: 45,
    });
  });

  it("a range edit can never collapse the lo–hi window to zero width", () => {
    // lo == hi maps the whole wired signal to a constant — dead modulation (the
    // slideshow-trigger bug). Each thumb edit keeps at least one step of width.
    const param = { min: 0, max: 1, step: 0.01 };
    // hi dragged all the way down onto lo: floored at lo + step.
    expect(clampRangeEdit(param, { lo: 0.5, hi: 1 }, "hi", 0.5)).toEqual({ lo: 0.5, hi: 0.51 });
    // lo dragged all the way up onto hi: capped at hi - step.
    expect(clampRangeEdit(param, { lo: 0, hi: 0.5 }, "lo", 0.5)).toEqual({ lo: 0.49, hi: 0.5 });
    // normal edits pass through untouched.
    expect(clampRangeEdit(param, { lo: 0, hi: 1 }, "lo", 0.25)).toEqual({ lo: 0.25, hi: 1 });
    expect(clampRangeEdit(param, { lo: 0, hi: 1 }, "hi", 0.75)).toEqual({ lo: 0, hi: 0.75 });
    // clamped to the param bounds even in degenerate legacy states.
    expect(clampRangeEdit(param, { lo: 0, hi: 0 }, "lo", 0).lo).toBeGreaterThanOrEqual(0);
    expect(clampRangeEdit(param, { lo: 1, hi: 1 }, "hi", 1).hi).toBeLessThanOrEqual(1);
  });

  it("static patches edit data.static", () => {
    const node = fluidNode(0, 0);
    const updater = patchStatic(node.id, { duration: 12 });
    const g2 = updater({ version: 1, nodes: [node], edges: [] });
    expect(
      ((g2.nodes[0].data as FluidData).static as unknown as Record<string, unknown>).duration
    ).toBe(12);
  });
});

describe("CombineNode", () => {
  it("merge mode: a video out port, one in port per slot, and shared medium controls", () => {
    const node = combineNode(0, 0);
    const html = renderToStaticMarkup(
      React.createElement(CombineNode, { ...h(node), onGraphChange: () => {} })
    );
    expect(html).toContain('data-port="out"'); // video out
    for (const slot of node.data.inputs) {
      expect(html).toContain(`data-port="${slot.id}"`); // each input slot port
    }
    expect(html).toContain("MEDIUM"); // merge medium block
    expect(html).toContain("merge");
    expect(html).toContain("layered");
    expect(html).not.toContain("anim-combine-opacity"); // no opacity in merge
  });

  it("layered mode: per-input opacity sliders, no shared-medium block", () => {
    const base = combineNode(0, 0);
    const node = { ...base, data: { ...base.data, mode: "stack" as const } };
    const html = renderToStaticMarkup(
      React.createElement(CombineNode, { ...h(node), onGraphChange: () => {} })
    );
    expect(html).toContain("anim-combine-opacity"); // opacity sliders
    expect(html).not.toContain("MEDIUM (shared)");
  });
});

describe("PointsNode (spec 11)", () => {
  it("renders a marker per point and a points-flow out port", () => {
    const node = pointsNode(0, 0);
    node.data.points = [
      [0.2, 0.3],
      [0.7, 0.8],
    ];
    const html = renderToStaticMarkup(
      React.createElement(PointsNode, { ...h(node), ctx: {}, onGraphChange: () => {} })
    );
    expect(html).toContain('data-port="out"');
    expect(html).toContain("gc-port-points");
    expect((html.match(/anim-points-marker/g) || []).length).toBe(2);
  });

  it("FluidNode shows a positions port and the wired point count", () => {
    const f = fluidNode(0, 0);
    const p = pointsNode(0, 0);
    p.data.points = [
      [0.1, 0.1],
      [0.2, 0.2],
      [0.3, 0.3],
    ];
    const graph: Graph = {
      version: 1,
      nodes: [f, p],
      edges: [{ id: "e", source: p.id, sourcePort: "out", target: f.id, targetPort: "positions" }],
    };
    const html = renderToStaticMarkup(
      React.createElement(FluidNode, {
        ...h(f),
        ctx: { graph },
        onGraphChange: () => {},
        onDetach: () => {},
      })
    );
    expect(html).toContain('data-port="positions"');
    expect(html).toContain("positions"); // the labelled row
    expect(html).toContain("3 points"); // wired point count
  });
});

describe("CompactCard", () => {
  const fluid = fluidNode(0, 0);
  const out = outputNode(0, 0);
  const sig = signalNode({ id: "s1", name: "kick" }, 0, 0);
  const graph = {
    version: 1,
    nodes: [sig, fluid, out],
    edges: [
      { id: "e1", source: sig.id, sourcePort: "out", target: fluid.id, targetPort: "force" },
      { id: "e2", source: sig.id, sourcePort: "out", target: fluid.id, targetPort: "r" },
      { id: "e3", source: fluid.id, sourcePort: "out", target: out.id, targetPort: "video" },
    ],
  };
  const helpers = {
    portRef: () => () => {},
    startConnect: () => {},
    onTitlePointerDown: () => {},
    onLayoutChange: () => {},
    selected: false,
  };

  // On canvas a compact card sits in the editor's compact set — provide it so the
  // header toggle reads "expand" (▢), exactly as renderAnimNode renders it.
  const renderCompact = (node: GraphNode) =>
    renderToStaticMarkup(
      React.createElement(
        MinimizeContext.Provider,
        { value: { minimized: new Set([node.id]), toggle: () => {} } },
        React.createElement(CompactCard, {
          node,
          helpers,
          ctx: { graph, signals: [] },
          onGraphChange: () => {},
          onDelete: () => {},
        })
      )
    );

  it("renders compact (preview body, no controls) with consolidated in/out anchors", () => {
    const html = renderCompact(fluid);
    expect(html).toContain("anim-node-fluid"); // card chrome kept
    expect(html).toContain("compact"); // compact-view class (body = preview only)
    expect(html).toContain("fluid"); // header title kept
    expect(html).toContain("▢"); // expand-on-canvas button
    expect(html).toContain('data-port="out"'); // single output anchor
    // inbound wires (force + r) consolidate onto ONE input anchor
    expect(html).toMatch(/data-port="(force|r)"/);
    expect(html).not.toContain('type="range"'); // full-card controls hidden
    expect(html).toContain("anim-compact-body"); // click target for the settings modal
  });

  it("a node with no inbound wires shows only the output anchor", () => {
    const html = renderCompact(sig);
    expect(html).toContain("anim-node-signal");
    expect(html).toContain('data-port="out"');
    expect(html).not.toContain("gc-port-in"); // no input anchor rendered
  });
});
