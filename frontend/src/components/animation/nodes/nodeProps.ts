// Shared types for the node cards. Lives in its own module (not registry.ts) so the
// card components can import it without a cycle (registry.ts imports the cards).

import type { PointerEvent, RefObject } from "react";
import type { Graph, GraphNode, OutputSettings, Segment, Signal } from "../../../lib/types";

// A ref callback the canvas hands each port so it can measure the port's centre.
export type PortRef = (
  nodeId: string,
  portId: string,
  kind: string,
  flow: string
) => (el: Element | null) => void;

// Canvas helpers passed to every card (from GraphCanvas via renderAnimNode).
export interface NodeHelpers {
  portRef: PortRef;
  startConnect: (nodeId: string, portId: string, flow: string, e: PointerEvent) => void;
  onTitlePointerDown: (e: PointerEvent) => void;
  onLayoutChange?: () => void;
  selected?: boolean;
}

// One signal definition as carried in segment.signals. The cards read only a few
// fields, but it's the same shape the studio edits — so it's the canonical `Signal`.
export type SignalDef = Signal;

// The editor context assembled by useGraphEditor + Studio, handed to every card.
// Most fields are optional because individual cards read only what they need (and
// guard with `ctx?.x`).
export interface NodeCtx {
  graph?: Graph;
  segment?: Segment;
  stems?: Record<string, unknown>;
  job?: unknown;
  output?: OutputSettings | null;
  signals?: SignalDef[];
  lyricLines?: unknown[]; // aligned lyric lines [{t0,t1,text}] for the lyrics card
  lyricsKey?: string; // JSON of lyricLines, serialized once for the outputs' render keys
  onSaveLyricLines?: (lines: unknown[]) => Promise<void>; // persist edited line text (keeps timings)
  groupClock?: RefObject<HTMLAudioElement | null>;
  groupPlaying?: boolean;
  segStart?: number;
  minimized?: Set<string>;
  // Set by the settings window on the ctx it hands the CARD (not CompactPreview): the
  // card's own inline live preview (StreamPreview/ValuePreview) then renders nothing, so
  // the modal's single right-column CompactPreview owns the visual (no double image, and
  // no duplicate fluid/combine render stream).
  previewInPanel?: boolean;
  finalOutputId?: string; // the segment's output marked "final" (for the export stage)
  setFinalOutput?: (nodeId: string) => void; // mark/clear this segment's final output ("" clears)
  onGraphChange?: (updater: (g: Graph) => Graph) => void;
  onDetach?: (fluidId: string, key: string) => void;
  onDeleteNode?: (id: string) => void;
}

// `ctx.job` is either the bare job id or the loaded project object, depending on the
// caller — every consumer needs the id, so normalize in one place.
export const jobIdOf = (job: unknown): string | undefined =>
  typeof job === "string" ? job : (job as { job_id?: string } | undefined)?.job_id;

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
