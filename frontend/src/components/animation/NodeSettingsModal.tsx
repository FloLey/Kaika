import { createPortal } from "react-dom";
import { portalTarget } from "../../lib/portalTarget";
import NodeInspector from "./NodeInspector";
import type { NodeCtx } from "./nodes/nodeProps";
import type { Graph, GraphNode } from "../../lib/types";
import { useEscapeKey } from "../../lib/useEscapeKey";

// The per-card settings window a CompactCard opens: the node's FULL card component,
// rendered in a modal instead of on the canvas. Same portal + scrim pattern as
// AssetLibrary (portal to <body> so the fixed scrim isn't clipped by the pan/zoomed
// canvas; Escape or a scrim click closes; clicks inside don't bubble out). The card
// edits the graph through the same onGraphChange/onDetach as on-canvas, and `node`
// is passed straight through from CompactCard — it updates on every graph commit, so
// the modal always shows the LIVE node (never a stale snapshot).
//
// The contents live in `NodeInspector`, which the ?ui=next dock renders too: the two
// arrangements have to show the same editor or comparing them proves nothing. This
// file is now only the window around it — portal, scrim, Escape.
export default function NodeSettingsModal({
  node,
  ctx,
  onGraphChange,
  onDetach,
  onClose,
}: {
  node: GraphNode;
  ctx: NodeCtx;
  onGraphChange: (updater: (g: Graph) => Graph) => void;
  onDetach?: (fluidId: string, key: string) => void;
  onClose: () => void;
}) {
  // ESC closes (same listener shape as AssetLibrary).
  useEscapeKey(onClose);

  return createPortal(
    <div
      className="anim-modal-scrim"
      onPointerDown={onClose}
      // The modal is portaled, but React events bubble through the REACT tree — so a
      // wheel here would reach the canvas onWheel and pan it "behind". Swallow it.
      onWheel={(e) => e.stopPropagation()}
    >
      <NodeInspector
        node={node}
        ctx={ctx}
        onGraphChange={onGraphChange}
        onDetach={onDetach}
        onClose={onClose}
        className="anim-modal node-settings"
      />
    </div>,
    portalTarget()
  );
}
