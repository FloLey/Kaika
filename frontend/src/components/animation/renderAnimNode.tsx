import type { ReactElement } from "react";
import CompactCard from "./nodes/CompactCard";
import { NODE_TYPES } from "./nodes/registry";
import type { NodeCtx, NodeHelpers } from "./nodes/nodeProps";
import type { GraphNode } from "../../lib/types";

// Resolves a graph node to its React card via the node-type registry. The container
// passes this to <GraphCanvas renderNode={(node, helpers) => renderAnimNode(node, helpers, ctx)}>.
// Returns the matching node component, or null for an unknown type.
export default function renderAnimNode(
  node: GraphNode,
  helpers: NodeHelpers,
  ctx: NodeCtx = {}
): ReactElement | null {
  const common = {
    node,
    selected: !!helpers.selected,
    helpers,
    ctx,
    onGraphChange: ctx.onGraphChange ?? (() => {}),
    onDelete: () => ctx.onDeleteNode?.(node.id),
  };
  // Every card is compact (header + live preview + consolidated wire anchors; its body
  // opens the settings modal). `output` is the one exception — its body IS the live
  // render preview, so it always shows full.
  if (node.type !== "output") {
    return (
      <CompactCard
        node={node}
        helpers={helpers}
        ctx={ctx}
        onGraphChange={common.onGraphChange}
        onDetach={ctx.onDetach}
        onDelete={common.onDelete}
      />
    );
  }
  const spec = NODE_TYPES[node.type];
  if (!spec) return null;
  const Card = spec.Component;
  // onDetach is only meaningful for the fluid card; harmless on the others.
  return <Card {...common} onDetach={ctx.onDetach} />;
}
