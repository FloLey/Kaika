import { useEffect } from "react";
import NodeFrame, { MultiAnchor } from "./NodeFrame";
import { chromeFor } from "./registry";
import { stemColor } from "../../../lib/segments";
import type { NodeProps } from "./nodeProps";

// renderAnimNode passes only these (no selection/onGraphChange for a collapsed card).
type MinimizedCardProps = Pick<NodeProps, "node" | "helpers" | "ctx" | "onDelete">;

// A card collapsed to just its header. All of the node's inbound wires re-route to
// ONE left anchor and its single `out` to ONE right anchor (both registered via
// MultiAnchor, the generalisation of FluidNode's GroupAnchor), so links stay
// connected while the body is hidden. renderAnimNode renders this in place of the
// full node when ctx.minimized has the node id. Header chrome (title/accent/outFlow)
// comes from the node-type registry; signal's accent follows its stem colour below.

export default function MinimizedCard({ node, helpers, ctx, onDelete }: MinimizedCardProps) {
  const base = chromeFor(node.type);
  let accent = base.accent;
  if (node.type === "signal") {
    const sig = (ctx.signals || []).find((s) => s.id === node.data.signalId);
    accent = sig ? stemColor(sig.stemKey) : "var(--muted)";
  }

  // Inbound wires -> their distinct target ports, all consolidated onto one anchor.
  const edges = ctx.graph?.edges || [];
  const inbound = [...new Set(edges.filter((e) => e.target === node.id).map((e) => e.targetPort))];

  // Re-anchor edges once this collapsed card has mounted its anchors.
  useEffect(() => {
    helpers.onLayoutChange?.();
  }, [helpers]);

  return (
    <NodeFrame
      node={node}
      title={base.title}
      accent={accent}
      selected={helpers.selected}
      onTitlePointerDown={helpers.onTitlePointerDown}
      onDelete={onDelete}
      minimized
      sideIn={
        inbound.length ? (
          <MultiAnchor
            nodeId={node.id}
            portRef={helpers.portRef}
            ports={inbound.map((p) => ({ portId: p, kind: "in", flow: "value" }))}
            className="anim-min-anchor"
            title={`${inbound.length} input${inbound.length === 1 ? "" : "s"} (minimized)`}
          />
        ) : null
      }
      sideOut={
        <MultiAnchor
          nodeId={node.id}
          portRef={helpers.portRef}
          startConnect={helpers.startConnect}
          ports={[{ portId: "out", kind: "out", flow: base.outFlow }]}
          className="anim-min-anchor"
          title="output (minimized)"
        />
      }
    />
  );
}
