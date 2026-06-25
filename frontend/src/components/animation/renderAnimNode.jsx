import SignalNode from "./nodes/SignalNode.jsx";
import ConstantNode from "./nodes/ConstantNode.jsx";
import FluidNode from "./nodes/FluidNode.jsx";
import OutputNode from "./nodes/OutputNode.jsx";

// The node-type switch (06 §Wiring it to the canvas). 07's container passes this
// to <GraphCanvas renderNode={(node, helpers) => renderAnimNode(node, helpers, ctx)}>.
//
// Signature (07 wires this EXACTLY):
//   renderAnimNode(node, helpers, ctx)
//     node    — the graph node ({ id, type, x, y, data })
//     helpers — from GraphCanvas: { onMove, portRef, startConnect, onTitlePointerDown, selected }
//     ctx     — { segment, stems, job, videoUrl, busy, error, signals,
//                 graph, onGraphChange, onDetach }
//       onGraphChange(updater)        — the canvas's graph-mutation callback
//       onDetach(fluidId, paramKey)   — disconnect a wired fluid param (graphModel.disconnect)
//       graph                         — current graph (for resolving wired source labels)
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
  switch (node.type) {
    case "signal":
      return <SignalNode {...common} />;
    case "constant":
      return <ConstantNode {...common} />;
    case "fluid":
      return <FluidNode {...common} onDetach={ctx.onDetach} />;
    case "output":
      return <OutputNode {...common} />;
    default:
      return null;
  }
}
