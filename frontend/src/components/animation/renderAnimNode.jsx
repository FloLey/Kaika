import MinimizedCard from "./nodes/MinimizedCard";
import { NODE_TYPES } from "./nodes/registry";

// Resolves a graph node to its React card via the node-type registry. 07's container
// passes this to <GraphCanvas renderNode={(node, helpers) => renderAnimNode(node, helpers, ctx)}>.
//
//   renderAnimNode(node, helpers, ctx)
//     node    — the graph node ({ id, type, x, y, data })
//     helpers — from GraphCanvas: { onMove, portRef, startConnect, onTitlePointerDown, selected }
//     ctx     — { segment, stems, job, signals, graph, onGraphChange, onDetach, minimized, ... }
//
// Returns the matching node component, or null for an unknown type.
export default function renderAnimNode(node, helpers, ctx = {}) {
  const common = {
    node,
    selected: helpers.selected,
    helpers,
    ctx,
    onGraphChange: ctx.onGraphChange,
    onDelete: () => ctx.onDeleteNode && ctx.onDeleteNode(node.id),
  };
  // Collapsed to header only: a generic card with consolidated wire anchors.
  if (ctx.minimized && ctx.minimized.has(node.id)) {
    return <MinimizedCard node={node} helpers={helpers} ctx={ctx} onDelete={common.onDelete} />;
  }
  const spec = NODE_TYPES[node.type];
  if (!spec) return null;
  const Card = spec.Component;
  // onDetach is only meaningful for the fluid card; harmless on the others.
  return <Card {...common} onDetach={ctx.onDetach} />;
}
