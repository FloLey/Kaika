// Shared types for the node cards. Lives in its own module (not registry.ts) so the
// card components can import it without a cycle (registry.ts imports the cards).

import type { PointerEvent, RefObject } from "react";
import type { Graph, GraphNode, OutputSettings } from "../../../lib/types";

// A ref callback the canvas hands each port so it can measure the port's centre.
export type PortRef = (
  nodeId: string, portId: string, kind: string, flow: string,
) => (el: Element | null) => void;

// Canvas helpers passed to every card (from GraphCanvas via renderAnimNode).
export interface NodeHelpers {
  portRef: PortRef;
  startConnect: (nodeId: string, portId: string, flow: string, e: PointerEvent) => void;
  onTitlePointerDown: (e: PointerEvent) => void;
  onLayoutChange?: () => void;
  selected?: boolean;
}

// One signal definition (as carried in segment.signals). Loose — only the fields the
// cards read are named.
export interface SignalDef {
  id: string;
  name?: string;
  stemKey?: string;
  feature?: string;
  [k: string]: unknown;
}

// The editor context assembled by useGraphEditor + Studio, handed to every card.
// Most fields are optional because individual cards read only what they need (and
// guard with `ctx?.x`).
export interface NodeCtx {
  graph?: Graph;
  segment?: { id?: string; start?: number; end?: number; signals?: SignalDef[] } & Record<string, unknown>;
  stems?: Record<string, unknown>;
  job?: unknown;
  output?: OutputSettings | null;
  signals?: SignalDef[];
  groupClock?: RefObject<HTMLAudioElement | null>;
  groupPlaying?: boolean;
  segStart?: number;
  minimized?: Set<string>;
  onGraphChange?: (updater: (g: Graph) => Graph) => void;
  onDetach?: (fluidId: string, key: string) => void;
  onDeleteNode?: (id: string) => void;
}

// The props every node card receives.
export interface NodeProps {
  node: GraphNode;
  selected: boolean;
  helpers: NodeHelpers;
  ctx: NodeCtx;
  onGraphChange: (updater: (g: Graph) => Graph) => void;
  onDetach?: (fluidId: string, key: string) => void;
  onDelete?: () => void;
}
