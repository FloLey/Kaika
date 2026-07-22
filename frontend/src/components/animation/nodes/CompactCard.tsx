import { useEffect, useState } from "react";
import NodeFrame, { MultiAnchor } from "./NodeFrame";
import CompactPreview from "./CompactPreview";
import NodeSettingsModal from "../NodeSettingsModal";
import { chromeFor } from "./registry";
import MontageCompactWarning from "./MontageCompactWarning";
import { cardInputs } from "../nodeInputs";
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
  // ASK the declared table rather than re-deriving it. This used to hardcode
  // `positions` -> points and fillColor/outlineColor/tint -> color, which is the same
  // knowledge `cardInputs` already publishes for every card — two copies, one of them
  // string literals, and a new port only ever added to the other. A wrong flow here is
  // not cosmetic: GraphCanvas validates a drop by flow (ports.ts canConnect), so it
  // would silently reject a legal wire dropped on a compact card.
  const declared = cardInputs(node).inputs.find((i) => i.portId === portId);
  if (declared) return declared.flow as "value" | "points" | "color" | "video";
  // Not declarable: a VIDEO input actually fed by a colour card carries colour. That
  // depends on the wiring, not the card, so it stays a lookup.
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
          title={
            node.type === "montage" && ctx?.enterMontage
              ? "open the montage editor"
              : "open settings"
          }
          onClick={() =>
            // A montage's full surface is the EDITOR (its own breadcrumb level) —
            // the modal stays the fallback where no navigation exists (tests, stubs).
            node.type === "montage" && ctx?.enterMontage
              ? ctx.enterMontage(node.id)
              : setSettingsOpen(true)
          }
        >
          <CompactPreview node={node} ctx={ctx} accent={accent} />
          {/* A montage's black-hole warning must survive being collapsed — see the
              component. Other card types have nothing to surface here yet. */}
          {node.type === "montage" && <MontageCompactWarning node={node} ctx={ctx} />}
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
