import type { ChangeEvent } from "react";
import NodeFrame, { Port } from "./NodeFrame";
import Ctl from "../../../ui/Ctl";
import ArgInfo from "./ArgInfo";
import ValuePreview from "./ValuePreview";
import { useNodeData } from "./useNodeData";
import { dp2 } from "./nodeConstants";
import { argHelp } from "../../../lib/paramHelp";
import type { NodeProps } from "./nodeProps";
import type { LfoData, LfoShape } from "../../../lib/types";

// The LFO / oscillator card: a 0..1 value generator with no audio input. A tempo-free
// wave (sine/triangle/saw/square) at a rate in cycles-per-clip or Hz. Drives idle
// drift, steady pulsing, slow colour sweeps. One `out` value port. The preview is the
// REAL resolved curve (from the backend), so it matches a Scope and the render exactly.
const SHAPES: LfoShape[] = ["sine", "triangle", "saw", "square"];

export default function LfoNode({ node, selected, helpers, ctx, onGraphChange, onDelete }: NodeProps) {
  const d = node.data as LfoData;
  const set = useNodeData<LfoData>(node, onGraphChange);

  return (
    <NodeFrame
      node={node}
      title="lfo"
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
        <div className="anim-select-row">
          <span className="anim-select-label">shape</span>
          <ArgInfo type="lfo" k="shape" />
        </div>
        <div className="anim-shape-row">
          {SHAPES.map((s) => (
            <button
              key={s}
              className={"anim-shape-btn" + (d.shape === s ? " on" : "")}
              onClick={() => set({ shape: s })}
              title={s}
            >
              {s}
            </button>
          ))}
        </div>
        <label className="anim-select-row">
          <span className="anim-select-label">rate</span>
          <ArgInfo type="lfo" k="rateMode" />
          <select
            className="anim-select"
            value={d.rateMode}
            onChange={(e: ChangeEvent<HTMLSelectElement>) =>
              set({ rateMode: e.target.value as LfoData["rateMode"] })
            }
          >
            <option value="cycles">cycles / clip</option>
            <option value="hz">hz</option>
          </select>
        </label>
        <Ctl
          label=""
          value={d.rate}
          min={d.rateMode === "hz" ? 0.05 : 0.25}
          max={d.rateMode === "hz" ? 8 : 32}
          step={d.rateMode === "hz" ? 0.05 : 0.25}
          fmt={(v) => (d.rateMode === "hz" ? `${v.toFixed(2)} Hz` : `${v}×`)}
          onChange={(v) => set({ rate: v })}
          {...argHelp("lfo", "rate")}
        />
        <Ctl
          label="phase"
          value={d.phase}
          min={0}
          max={1}
          step={0.01}
          fmt={dp2}
          onChange={(v) => set({ phase: v })}
          {...argHelp("lfo", "phase")}
        />
        {d.shape === "square" && (
          <Ctl
            label="duty"
            value={d.duty}
            min={0.05}
            max={0.95}
            step={0.05}
            fmt={dp2}
            onChange={(v) => set({ duty: v })}
            {...argHelp("lfo", "duty")}
          />
        )}
      </div>
    </NodeFrame>
  );
}
