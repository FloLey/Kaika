import { useEffect } from "react";
import { createPortal } from "react-dom";
import { portalTarget } from "../../lib/portalTarget";
import { NODE_TYPES, chromeFor } from "./nodes/registry";
import InputPicker from "./InputPicker";
import { MinimizeContext } from "./nodes/minimizeContext";
import type { MinimizeCtx } from "./nodes/minimizeContext";
import type { NodeCtx, NodeHelpers } from "./nodes/nodeProps";
import type { Graph, GraphNode } from "../../lib/types";

// The per-card settings window a CompactCard opens: the node's FULL card component,
// rendered in a modal instead of on the canvas. Same portal + scrim pattern as
// AssetLibrary (portal to <body> so the fixed scrim isn't clipped by the pan/zoomed
// canvas; Escape or a scrim click closes; clicks inside don't bubble out). The card
// edits the graph through the same onGraphChange/onDetach as on-canvas, and `node`
// is passed straight through from CompactCard — it updates on every graph commit, so
// the modal always shows the LIVE node (never a stale snapshot).

// Canvas helpers stubbed out: the modal has no wiring canvas, so ports register into
// the void (their dots are hidden via .node-settings CSS), drags from an out port do
// nothing, the title bar doesn't drag, and there's no edge layout to re-anchor.
const STUB_HELPERS: NodeHelpers = {
  portRef: () => () => {},
  startConnect: () => {},
  onTitlePointerDown: () => {},
  onLayoutChange: () => {},
};

// The card in the modal must NOT consult the editor's compact set (it would hide its
// own body — the node IS compact on canvas); an empty set renders it full. The no-op
// toggle keeps the (CSS-hidden) header button inert.
const MODAL_MIN_CTX: MinimizeCtx = { minimized: new Set<string>(), toggle: () => {} };

interface NodeSettingsModalProps {
  node: GraphNode;
  ctx: NodeCtx;
  onGraphChange: (updater: (g: Graph) => Graph) => void;
  onDetach?: (fluidId: string, key: string) => void;
  onClose: () => void;
}

export default function NodeSettingsModal({
  node,
  ctx,
  onGraphChange,
  onDetach,
  onClose,
}: NodeSettingsModalProps) {
  // ESC closes (same listener shape as AssetLibrary).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const spec = NODE_TYPES[node.type];
  if (!spec) return null;
  const Card = spec.Component;

  return createPortal(
    <div
      className="anim-modal-scrim"
      onPointerDown={onClose}
      // The modal is portaled, but React events bubble through the REACT tree — so a
      // wheel here would reach the canvas onWheel and pan it "behind". Swallow it.
      onWheel={(e) => e.stopPropagation()}
    >
      <div
        className="anim-modal node-settings"
        role="dialog"
        aria-label={`${chromeFor(node.type).title} settings`}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {ctx.graph && (
          <InputPicker
            node={node}
            graph={ctx.graph}
            signals={ctx.signals}
            onGraphChange={onGraphChange}
          />
        )}
        <MinimizeContext.Provider value={MODAL_MIN_CTX}>
          <Card
            node={node}
            selected={false}
            helpers={STUB_HELPERS}
            ctx={ctx}
            onGraphChange={onGraphChange}
            onDetach={onDetach}
            onDelete={undefined}
          />
        </MinimizeContext.Provider>
      </div>
    </div>,
    portalTarget()
  );
}
