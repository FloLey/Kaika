// THE node-type registry: one entry per node type is the single source of truth for
// how it's created, rendered, themed, and added from the palette. Adding a node type
// = add a Component + one entry here (+ a backend handler) — no edits to Palette,
// renderAnimNode, or MinimizedCard.
//
// Import direction (no cycles): registry -> node components + graphModel factories.
// Consumers (Palette / renderAnimNode / MinimizedCard) import the registry; the node
// components and graphModel must NOT import it.

import type { ComponentType } from "react";
import SignalNode from "./SignalNode";
import FluidNode from "./FluidNode";
import OutputNode from "./OutputNode";
import CombineNode from "./CombineNode";
import PointsNode from "./PointsNode";
import { fluidNode, outputNode, combineNode, pointsNode } from "../../../lib/graphModel";
import type { GraphNode, NodeType, PortFlow } from "../../../lib/types";
import type { NodeProps } from "./nodeProps";

export type { NodeProps }; // re-export so existing importers keep working

export interface NodeChrome {
  title: string;
  accent: string; // CSS colour; signal overrides with its stem colour
  outFlow: PortFlow; // the flow of the node's single `out` port
}

export interface NodeSpec {
  type: NodeType;
  // The card component — now that every card is .tsx and implements NodeProps, a card
  // whose props don't match is a compile error.
  Component: ComponentType<NodeProps>;
  chrome: NodeChrome;
  // Generic palette factory (x, y) -> node. Omitted for `signal` (added via the
  // signal picker, not a plain button).
  factory?: (x: number, y: number) => GraphNode;
  palette?: { label: string; title?: string; order: number };
}

export const NODE_TYPES: Record<NodeType, NodeSpec> = {
  signal: {
    type: "signal",
    Component: SignalNode,
    chrome: { title: "signal", accent: "var(--muted)", outFlow: "value" },
  },
  fluid: {
    type: "fluid",
    Component: FluidNode,
    chrome: { title: "fluid", accent: "var(--petale)", outFlow: "video" },
    factory: fluidNode,
    palette: { label: "+ Fluid", order: 1 },
  },
  points: {
    type: "points",
    Component: PointsNode,
    chrome: { title: "points", accent: "var(--courant)", outFlow: "points" },
    factory: pointsNode,
    palette: {
      label: "+ Points",
      title: "Draw source points to feed a fluid's positions",
      order: 2,
    },
  },
  combine: {
    type: "combine",
    Component: CombineNode,
    chrome: { title: "combine", accent: "#c0902e", outFlow: "video" },
    factory: combineNode,
    palette: {
      label: "+ Combine",
      title: "Combine fluids — merge (interact) or layered (stack)",
      order: 3,
    },
  },
  output: {
    type: "output",
    Component: OutputNode,
    chrome: { title: "output", accent: "var(--text)", outFlow: "video" },
    factory: outputNode,
    palette: { label: "+ Output", order: 4 },
  },
};

// The palette-addable specs (have a generic factory + button), in button order.
export const paletteSpecs = (): NodeSpec[] =>
  Object.values(NODE_TYPES)
    .filter((s) => s.palette && s.factory)
    .sort((a, b) => a.palette!.order - b.palette!.order);

// Header chrome for a node type, with a safe fallback for unknown types.
export const chromeFor = (type: string): NodeChrome =>
  NODE_TYPES[type as NodeType]?.chrome || { title: type, accent: "var(--muted)", outFlow: "value" };
