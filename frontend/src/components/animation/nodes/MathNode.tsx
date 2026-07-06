import type { ChangeEvent } from "react";
import NodeFrame, { Port } from "./NodeFrame";
import Ctl from "../../../ui/Ctl";
import ArgInfo from "./ArgInfo";
import ValuePreview from "./ValuePreview";
import { patchNodeData, addInputPort, removeInputPort } from "../../../lib/graphModel";
import { argHelp } from "../../../lib/paramHelp";
import type { NodeProps } from "./nodeProps";
import type { MathData, MathOp } from "../../../lib/types";

// The math / blend card: folds 2+ value inputs into one. Inputs are plain value
// edges (no lo/hi mapping) targeted by port id. `mix` crossfades the first two
// inputs (op "mix"); every other op folds all wired inputs elementwise. One `out`.
const OPS: { op: MathOp; label: string }[] = [
  { op: "multiply", label: "× multiply" },
  { op: "add", label: "+ add" },
  { op: "subtract", label: "− subtract" },
  { op: "max", label: "▲ max" },
  { op: "min", label: "▼ min" },
  { op: "mix", label: "≈ mix" },
];

export default function MathNode({ node, selected, helpers, ctx, onGraphChange, onDelete }: NodeProps) {
  const d = node.data as MathData;
  const inputs = d.inputs || [];

  return (
    <NodeFrame
      node={node}
      title="math"
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
        <label className="anim-select-row">
          <span className="anim-select-label">op</span>
          <ArgInfo type="math" k="op" />
          <select
            className="anim-select"
            value={d.op}
            onChange={(e: ChangeEvent<HTMLSelectElement>) =>
              onGraphChange((g) => patchNodeData(g, node.id, { op: e.target.value }))
            }
          >
            {OPS.map((o) => (
              <option key={o.op} value={o.op}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <div className="anim-math-inputs">
          {inputs.map((portId, i) => (
            <div className="anim-math-row" key={portId}>
              <Port
                kind="in"
                flow="value"
                nodeId={node.id}
                portId={portId}
                portRef={helpers.portRef}
                title={`input ${i + 1}`}
              />
              <span className="anim-math-slot">in {i + 1}</span>
              {inputs.length > 2 && (
                <button
                  className="iconbtn sm anim-math-rm"
                  onClick={() => onGraphChange((g) => removeInputPort(g, node.id, portId))}
                  title="remove input"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          <button
            className="btn sm anim-math-add"
            onClick={() => onGraphChange((g) => addInputPort(g, node.id))}
          >
            + input
          </button>
        </div>

        {d.op === "mix" && (
          <Ctl
            label="mix"
            value={d.mix ?? 0.5}
            min={0}
            max={1}
            step={0.01}
            fmt={(v) => v.toFixed(2)}
            onChange={(v) => onGraphChange((g) => patchNodeData(g, node.id, { mix: v }))}
            {...argHelp("math", "mix")}
          />
        )}
      </div>
    </NodeFrame>
  );
}
