import { useEffect, useState } from "react";
import NodeFrame, { MultiAnchor } from "./NodeFrame";
import CompactPreview from "./CompactPreview";
import NodeSettingsModal from "../NodeSettingsModal";
import { chromeFor } from "./registry";
import { nodeParam } from "../../../lib/nodeParams";
import { stemColor } from "../../../lib/segments";
import { isLooseEdge } from "../../../lib/graphModel";
import type { NodeProps } from "./nodeProps";

// renderAnimNode passes these; onGraphChange/onDetach feed the settings modal.
type CompactCardProps = Pick<
  NodeProps,
  "node" | "helpers" | "ctx" | "onGraphChange" | "onDetach" | "onDelete"
>;

// The DEFAULT card view: header + a small live preview, with all the node's inbound
// wires re-routed to ONE left anchor and its single `out` to ONE right anchor (both
// registered via MultiAnchor, the generalisation of FluidNode's GroupAnchor), so links
// stay connected while the detailed body is hidden. Clicking the preview body opens
// the full card in a settings modal; the header's ▢ expands it on the canvas instead.
// renderAnimNode renders this whenever ctx.minimized (the compact set) has the node id
// — except `output`, whose body IS the render preview and never compacts. Header chrome
// (title/accent/outFlow) comes from the registry; signal's accent follows its stem.

// The flow a wire INTO `portId` carries — MultiAnchor re-registers each inbound port,
// and GraphCanvas validates a drop by flow (ports.ts canConnect), so a wrong flow
// would reject legal wires dropped on a compact card. Modulatable params take values;
// `positions` is the fluid's points input; fill/outline (lyrics) and anything fed by a
// color card carry color; every remaining input (output video, combine slots…) is video.
function inFlow(
  portId: string,
  node: NodeProps["node"],
  ctx: NodeProps["ctx"]
): "value" | "points" | "color" | "video" {
  if (nodeParam(node.type, portId)) return "value";
  if (portId === "positions") return "points";
  if (portId === "fillColor" || portId === "outlineColor") return "color";
  const edge = (ctx.graph?.edges || []).find(
    (e) => e.target === node.id && e.targetPort === portId
  );
  const src = edge && ctx.graph?.nodes.find((n) => n.id === edge.source);
  if (src?.type === "color") return "color";
  return "video";
}

export default function CompactCard({
  node,
  helpers,
  ctx,
  onGraphChange,
  onDetach,
  onDelete,
}: CompactCardProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const base = chromeFor(node.type);
  let accent = base.accent;
  if (node.type === "signal") {
    const sig = (ctx.signals || []).find((s) => s.id === node.data.signalId);
    accent = sig ? stemColor(sig.stemKey) : "var(--muted)";
  }

  // Inbound wires -> their distinct target ports, all consolidated onto one anchor.
  // Loose (parked, unassigned) wires are EXCLUDED: they anchor to the card-body wrapper
  // and render gray until assigned in the settings window — folding "__in" in here would
  // double-register that anchor and pull a not-yet-assigned wire onto the input dot.
  const edges = ctx.graph?.edges || [];
  const inbound = [
    ...new Set(
      edges.filter((e) => e.target === node.id && !isLooseEdge(e)).map((e) => e.targetPort)
    ),
  ];

  // Re-anchor edges once this compact card has mounted its anchors.
  useEffect(() => {
    helpers.onLayoutChange?.();
  }, [helpers]);

  return (
    <>
      <NodeFrame
        node={node}
        title={base.title}
        accent={accent}
        selected={helpers.selected}
        onTitlePointerDown={helpers.onTitlePointerDown}
        onDelete={onDelete}
        // Visuals ≠ state: the body (our preview) SHOWS even though the editor holds
        // this card compact — the header toggle still reads the compact state (▢).
        minimized={false}
        compact
        sideIn={
          inbound.length ? (
            <MultiAnchor
              nodeId={node.id}
              portRef={helpers.portRef}
              ports={inbound.map((p) => ({ portId: p, kind: "in", flow: inFlow(p, node, ctx) }))}
              className="anim-min-anchor"
              title={`${inbound.length} input${inbound.length === 1 ? "" : "s"} (compact)`}
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
            title="output (compact)"
          />
        }
      >
        {/* .no-drag comes from NodeFrame's body wrapper; only the title bar drags. */}
        <button
          type="button"
          className="anim-compact-body"
          title="open settings"
          onClick={() => setSettingsOpen(true)}
        >
          <CompactPreview node={node} ctx={ctx} accent={accent} />
        </button>
      </NodeFrame>
      {settingsOpen && (
        <NodeSettingsModal
          node={node}
          ctx={ctx}
          onGraphChange={onGraphChange}
          onDetach={onDetach}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </>
  );
}
