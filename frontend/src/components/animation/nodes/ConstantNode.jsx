import Ctl from "../../../ui/Ctl.jsx";
import NodeFrame, { Port } from "./NodeFrame.jsx";

// A flat 0..1 value source (01 §3.1 constant). One slider bound to data.value,
// plus a numeric readout, and one `out` port. The value stays normalized; the
// receiving fluid port maps it into native units (lo/hi on the binding).
export default function ConstantNode({ node, selected, helpers, onGraphChange, onDelete }) {
  const setValue = (v) =>
    onGraphChange((g) => ({
      ...g,
      nodes: g.nodes.map((n) =>
        n.id === node.id ? { ...n, data: { ...n.data, value: v } } : n
      ),
    }));

  return (
    <NodeFrame
      node={node}
      title="constant"
      accent="var(--courant)"
      selected={selected}
      onTitlePointerDown={helpers.onTitlePointerDown}
      onDelete={onDelete}
      sideOut={
        <Port
          kind="out"
          flow="value"
          nodeId={node.id}
          portId="out"
          portRef={helpers.portRef}
          startConnect={helpers.startConnect}
          title="value out"
        />
      }
    >
      <Ctl
        label="value"
        value={node.data.value}
        min={0}
        max={1}
        step={0.01}
        fmt={(v) => v.toFixed(2)}
        onChange={setValue}
      />
    </NodeFrame>
  );
}
