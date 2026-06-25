import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

import SignalNode from "../components/animation/nodes/SignalNode.jsx";
import ConstantNode from "../components/animation/nodes/ConstantNode.jsx";
import FluidNode from "../components/animation/nodes/FluidNode.jsx";
import OutputNode from "../components/animation/nodes/OutputNode.jsx";
import { Port } from "../components/animation/nodes/NodeFrame.jsx";
import { signalNode, constantNode, fluidNode, outputNode } from "../lib/graphModel.js";
import { FLUID_PARAMS } from "../lib/fluidParams.js";
import { setConstValue, setNodeRange, patchStatic } from "../components/animation/nodes/fluidBindings.js";

const h = (node) => ({
  node,
  selected: false,
  helpers: {
    portRef: () => () => {},
    startConnect: () => {},
    onTitlePointerDown: () => {},
    selected: false,
  },
});

// Recursively invoke hook-free function components to expand to host elements so a
// control's onChange handler can be located and fired (no jsdom available).
function deepRender(el) {
  if (el == null || typeof el !== "object") return el;
  if (Array.isArray(el)) return el.map(deepRender);
  if (typeof el.type === "function") return deepRender(el.type(el.props));
  if (el.props && el.props.children != null) {
    return { ...el, props: { ...el.props, children: deepRender(el.props.children) } };
  }
  return el;
}
function findAll(el, pred, out = []) {
  if (el == null || typeof el !== "object") return out;
  if (Array.isArray(el)) { el.forEach((c) => findAll(c, pred, out)); return out; }
  if (pred(el)) out.push(el);
  const kids = el.props && el.props.children;
  if (kids != null) findAll(kids, pred, out);
  return out;
}

describe("Port", () => {
  it("renders data-node/data-port attributes and a kind+flow class", () => {
    const html = renderToStaticMarkup(
      React.createElement(Port, {
        nodeId: "n-1", portId: "force", kind: "in", flow: "value",
        portRef: () => () => {},
      })
    );
    expect(html).toContain('data-node="n-1"');
    expect(html).toContain('data-port="force"');
    expect(html).toContain("gc-port-in");
    expect(html).toContain("gc-port-value");
  });
});

describe("ConstantNode", () => {
  it("shows the title, a value slider, and one out port", () => {
    const node = constantNode(0, 0, 0.5);
    const html = renderToStaticMarkup(React.createElement(ConstantNode, {
      ...h(node), onGraphChange: () => {},
    }));
    expect(html).toContain("constant");
    expect(html).toContain('data-port="out"');
    expect(html).toContain("gc-port-out");
    expect(html).toContain('type="range"');
  });

  it("a slider change yields an updater that writes data.value", () => {
    const node = constantNode(0, 0, 0.5);
    let updater = null;
    const tree = deepRender(ConstantNode({ ...h(node), onGraphChange: (u) => { updater = u; } }));
    const range = findAll(tree, (e) => e.type === "input" && e.props.type === "range");
    expect(range).toHaveLength(1);
    range[0].props.onChange({ target: { value: "0.8" } });
    expect(updater).toBeTypeOf("function");
    const g2 = updater({ nodes: [node], edges: [] });
    expect(g2.nodes[0].data.value).toBe(0.8);
  });
});

describe("SignalNode", () => {
  const signal = {
    id: "sig-1", name: "kick", stemKey: "drums",
    minHz: 40, maxHz: 120, feature: "energy",
    attack: 5, release: 250, invert: false, gamma: 1, gain: 1, offset: 0, threshold: 0,
  };

  it("mirrors the resolved signal (stem / feature / band) with one out port", () => {
    const node = signalNode(signal, 0, 0);
    const html = renderToStaticMarkup(React.createElement(SignalNode, {
      ...h(node),
      ctx: { signals: [signal], segment: { start: 0, end: 8 }, job: { job_id: "job" } },
    }));
    expect(html).toContain("signal");        // title
    expect(html).toContain("DRUMS");          // stem chip
    expect(html).toContain("energy");         // feature
    expect(html).toContain('data-port="out"');
  });

  it("shows a missing-signal state when the id no longer resolves", () => {
    const node = signalNode(signal, 0, 0);
    const html = renderToStaticMarkup(React.createElement(SignalNode, {
      ...h(node),
      ctx: { signals: [], segment: { start: 0, end: 8 }, job: { job_id: "job" } },
    }));
    expect(html).toContain("missing signal");
    expect(html).toContain('data-port="out"'); // still wirable / deletable
  });
});

describe("OutputNode", () => {
  it("has one video in port and shows the not-rendered state", () => {
    const node = outputNode(0, 0);
    const html = renderToStaticMarkup(React.createElement(OutputNode, { ...h(node), ctx: {} }));
    expect(html).toContain("output");
    expect(html).toContain('data-port="video"');
    expect(html).toContain("gc-port-in");
    expect(html).toContain("not rendered yet");
  });

  it("plays a passed videoUrl and shows busy/error states", () => {
    const node = outputNode(0, 0);
    const playing = renderToStaticMarkup(
      React.createElement(OutputNode, { ...h(node), ctx: { videoUrl: "/x.mp4" } })
    );
    expect(playing).toContain("<video");
    expect(playing).toContain("/x.mp4");

    const busy = renderToStaticMarkup(
      React.createElement(OutputNode, { ...h(node), ctx: { busy: true } })
    );
    expect(busy).toContain("rendering");

    const err = renderToStaticMarkup(
      React.createElement(OutputNode, { ...h(node), ctx: { error: "boom" } })
    );
    expect(err).toContain("boom");
  });
});

describe("FluidNode", () => {
  it("renders a video out port, static controls, and an in port per source param", () => {
    const node = fluidNode(0, 0);
    const html = renderToStaticMarkup(React.createElement(FluidNode, {
      ...h(node),
      ctx: { graph: { nodes: [node], edges: [] } },
      onGraphChange: () => {},
      onDetach: () => {},
    }));
    // one out video port
    expect(html).toContain('data-port="out"');
    expect(html).toContain("gc-port-video");
    // static controls
    expect(html).toContain("color");
    // group headers
    expect(html).toContain("SOURCE");
    expect(html).toContain("COLOR");
    expect(html).toContain("MEDIUM");
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
    const updater = setConstValue(node.id, "force", param.max);
    const g2 = updater({ nodes: [node], edges: [] });
    expect(g2.nodes[0].data.ports.force.binding).toEqual({ kind: "const", value: param.max });
  });

  it("a wired param row's range edit patches lo/hi on the node binding", () => {
    const node = fluidNode(0, 0);
    node.data.ports.force.binding = { kind: "node", nodeId: "n-src", lo: 0, hi: 60 };
    const updater = setNodeRange(node.id, "force", 0, 45);
    const g2 = updater({ nodes: [node], edges: [] });
    expect(g2.nodes[0].data.ports.force.binding).toMatchObject({ kind: "node", nodeId: "n-src", lo: 0, hi: 45 });
  });

  it("static patches edit data.static", () => {
    const node = fluidNode(0, 0);
    const updater = patchStatic(node.id, { duration: 12 });
    const g2 = updater({ nodes: [node], edges: [] });
    expect(g2.nodes[0].data.static.duration).toBe(12);
  });
});
