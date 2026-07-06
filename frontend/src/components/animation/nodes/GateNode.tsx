import NodeFrame, { Port } from "./NodeFrame";
import Ctl, { Toggle } from "../../../ui/Ctl";
import ValuePreview from "./ValuePreview";
import { useNodeData } from "./useNodeData";
import { dp2 } from "./nodeConstants";
import { argHelp } from "../../../lib/paramHelp";
import type { NodeProps } from "./nodeProps";
import type { GateData } from "../../../lib/types";

// The gate card: any 0..1 value in → a clean 0/1 square out, via hysteresis
// thresholding (arms above threshold + hysteresis/2, releases below
// threshold − hysteresis/2 — a signal hovering at the threshold can't flicker).
// The binary signal drives on/off-style ports anywhere: an imagegen trigger, a
// fluid's emit, a lyrics opacity… Input `in` (value) → `out` (value).
export default function GateNode({ node, selected, helpers, ctx, onGraphChange, onDelete }: NodeProps) {
  const d = node.data as GateData;
  const set = useNodeData<GateData>(node, onGraphChange);

  return (
    <NodeFrame
      node={node}
      title="gate"
      accent="var(--mod)"
      selected={selected}
      onTitlePointerDown={helpers.onTitlePointerDown}
      onDelete={onDelete}
      sideIn={
        <Port
          kind="in"
          flow="value"
          nodeId={node.id}
          portId="in"
          portRef={helpers.portRef}
          title="value in"
        />
      }
      sideOut={
        <Port
          kind="out"
          flow="value"
          nodeId={node.id}
          portId="out"
          portRef={helpers.portRef}
          startConnect={helpers.startConnect}
          title="0/1 out"
        />
      }
    >
      <div className="anim-mod">
        <ValuePreview node={node} ctx={ctx} />
        <Ctl
          label="threshold"
          value={d.threshold}
          min={0}
          max={1}
          step={0.01}
          fmt={dp2}
          onChange={(v) => set({ threshold: v })}
          {...argHelp("gate", "threshold")}
        />
        <Ctl
          label="hysteresis"
          value={d.hysteresis}
          min={0}
          max={0.5}
          step={0.01}
          fmt={dp2}
          onChange={(v) => set({ hysteresis: v })}
          {...argHelp("gate", "hysteresis")}
        />
        <Ctl
          label="min gap"
          value={d.minGap ?? 0}
          min={0}
          max={10}
          step={0.1}
          fmt={(v) => (v > 0 ? `${v.toFixed(1)}s` : "off")}
          onChange={(v) => set({ minGap: v })}
          {...argHelp("gate", "minGap")}
        />
        <Ctl
          label="divide"
          value={d.divide ?? 1}
          min={1}
          max={8}
          step={1}
          fmt={(v) => `1/${v}`}
          onChange={(v) => set({ divide: v })}
          {...argHelp("gate", "divide")}
        />
        <Toggle
          label="invert"
          value={d.invert}
          onChange={(v) => set({ invert: v })}
          {...argHelp("gate", "invert")}
        />
      </div>
    </NodeFrame>
  );
}
