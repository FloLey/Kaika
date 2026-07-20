// Shared types for the node cards. Lives in its own module (not registry.ts) so the
// card components can import it without a cycle (registry.ts imports the cards).

import type { PointerEvent, RefObject } from "react";
import type {
  Asset,
  Graph,
  GraphNode,
  LyricLine,
  OutputSettings,
  Segment,
  Signal,
  StemInfo,
} from "../../../lib/types";
import type { ExportSettings } from "../../../lib/export";

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

// The canonical no-op implementation, for the two places that render a card OUTSIDE the
// wiring canvas: the settings modal and the input picker. Port dots register into the
// void (hidden via .node-settings CSS), drags from an out port do nothing, the title bar
// doesn't drag, and there is no edge layout to re-anchor.
//
// It lives HERE, beside the interface, because both call sites had their own copy with
// identical bodies — and one of them was `as unknown as NodeHelpers`. That cast is the
// reason this is worth one definition rather than two: add a required member to
// NodeHelpers and the typed copy fails to compile (correct), while the cast copy keeps
// compiling and is simply missing it at runtime.
export const STUB_HELPERS: NodeHelpers = {
  portRef: () => () => {},
  startConnect: () => {},
  onTitlePointerDown: () => {},
  onLayoutChange: () => {},
};

// The editor context assembled by useGraphEditor + Studio, handed to every card.
// Most fields are optional because individual cards read only what they need (and
// guard with `ctx?.x`).
export interface NodeCtx {
  graph?: Graph;
  segment?: Segment;
  stems?: Record<string, StemInfo>;
  job?: string;
  output?: OutputSettings | null;
  // The project's FINAL-EXPORT settings (size/fps/detail/audio). The Output card's
  // HD render uses exactly these — surfaced so the button can say what it will
  // produce before the user commits to a minutes-long render.
  exportSettings?: ExportSettings;
  signals?: Signal[];
  // The project's asset library. Cards read metadata from it (the montage's per-slot
  // "clip too short" warning needs each video's duration) instead of measuring in the
  // browser — probing a 1 GB source per card is what stalled the editor.
  assets?: Asset[];
  lyricLines?: LyricLine[]; // aligned lyric lines for the lyrics card
  lyricsKey?: string; // JSON of lyricLines, serialized once for the outputs' render keys
  onSaveLyricLines?: (lines: LyricLine[]) => Promise<void>; // persist edited text (keeps timings)
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
// `ctx.job` is the project id, a plain string (App holds it as `string | null`). This
// used to be typed `unknown`, which forced a `job as string` cast at every read —
// including useStreamRender's, which passed the cast value straight to the API.
export const jobIdOf = (job?: string): string | undefined => job || undefined;

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
