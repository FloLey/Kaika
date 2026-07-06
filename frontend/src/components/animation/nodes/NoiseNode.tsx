import NodeFrame, { Port } from "./NodeFrame";
import Ctl from "../../../ui/Ctl";
import ValuePreview from "./ValuePreview";
import { useNodeData } from "./useNodeData";
import { argHelp } from "../../../lib/paramHelp";
import type { NodeProps } from "./nodeProps";
import type { NoiseData } from "../../../lib/types";

// The noise card: smooth, non-repeating 0..1 wander (fractal value noise). Organic
// variation where an LFO would feel mechanical. Seeded, so it renders the same each
// time (the seed feeds the render cache). One `out` value port. The preview is the
// REAL resolved curve (from the backend), so it matches a Scope and the render exactly.
export default function NoiseNode({
  node,
  selected,
  helpers,
  ctx,
  onGraphChange,
  onDelete,
}: NodeProps) {
  const d = node.data as NoiseData;
  const set = useNodeData<NoiseData>(node, onGraphChange);

  return (
    <NodeFrame
      node={node}
      title="noise"
      accent="var(--mod)"
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
      <div className="anim-mod">
        <ValuePreview node={node} ctx={ctx} />
        <Ctl
          label="rate"
          value={d.rate}
          min={0.1}
          max={8}
          step={0.1}
          fmt={(v) => `${v.toFixed(1)}×`}
          onChange={(v) => set({ rate: v })}
          {...argHelp("noise", "rate")}
        />
        <Ctl
          label="detail"
          value={d.octaves}
          min={1}
          max={4}
          step={1}
          fmt={(v) => `${v} oct`}
          onChange={(v) => set({ octaves: v })}
          {...argHelp("noise", "octaves")}
        />
        <Ctl
          label="seed"
          value={d.seed}
          min={1}
          max={99}
          step={1}
          fmt={(v) => `#${v}`}
          onChange={(v) => set({ seed: v })}
          {...argHelp("noise", "seed")}
        />
      </div>
    </NodeFrame>
  );
}
