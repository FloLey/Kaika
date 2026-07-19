import type { ChangeEvent } from "react";
import Ctl from "../../../ui/Ctl";
import NodeFrame, { Port } from "./NodeFrame";
import ArgInfo from "./ArgInfo";
import StreamPreview from "./StreamPreview";
import { ctxAspect } from "../../../lib/output";
import { fluidParam } from "../../../lib/fluidParams.js";
import { argHelp } from "../../../lib/paramHelp";
import {
  setCombineMode,
  setCombineOpacity,
  setCombineMedium,
  setCombineLayer,
  addCombineInput,
  removeCombineInput,
} from "../../../lib/graphModel";
import type { NodeProps } from "./nodeProps";
import type { CombineData, CombineMedium } from "../../../lib/types";

// The combine card (spec 10): composes N video inputs into one video output.
//  • merge  — the inputs' emitters share ONE simulation (they interact), using
//             this card's MEDIUM controls.
//  • layered — each input is rendered, then alpha-over stacked (input order = top
//             first) with a per-input OPACITY slider.
// Dynamic N inputs: each slot is a video `in` port (+ a ✕ to remove); `+ input`
// adds another. One video `out` port. v1 combine settings are static (signals
// still drive the upstream fluids).
const MEDIUM_KEYS: (keyof CombineMedium)[] = [
  "dissipation",
  "velocity_dissipation",
  "viscosity",
  "vorticity",
];

export default function CombineNode({
  node,
  selected,
  helpers,
  ctx,
  onGraphChange,
  onDelete,
}: NodeProps) {
  const d = node.data as CombineData;
  const mode = d.mode || "merge";
  const inputs = d.inputs || [];

  return (
    <NodeFrame
      node={node}
      title="combine"
      accent="var(--fx)"
      selected={selected}
      onTitlePointerDown={helpers.onTitlePointerDown}
      onDelete={onDelete}
      sideOut={
        <Port
          kind="out"
          flow="video"
          nodeId={node.id}
          portId="out"
          portRef={helpers.portRef}
          startConnect={helpers.startConnect}
          title="video out"
        />
      }
    >
      {/* Live composite preview — every on-screen composite streams (no selection
          needed); the global 2-slot queue in useStreamRender staggers renders so the
          pool never floods, and each holds its looping frame once rendered. */}
      <StreamPreview node={node} ctx={ctx} aspect={ctxAspect(ctx)} />
      <div className="anim-combine-modes">
        <button
          className={"anim-mode-btn" + (mode === "merge" ? " on" : "")}
          onClick={() => onGraphChange((g) => setCombineMode(g, node.id, "merge"))}
        >
          merge
        </button>
        <button
          className={"anim-mode-btn" + (mode === "stack" ? " on" : "")}
          onClick={() => onGraphChange((g) => setCombineMode(g, node.id, "stack"))}
        >
          layered
        </button>
      </div>
      <div className="anim-combine-hint">
        {mode === "merge"
          ? "sources share one simulation — they interact"
          : "stacked with transparency (top → bottom)"}
        <ArgInfo type="combine" k="mode" />
      </div>

      <div className="anim-combine-inputs">
        {inputs.map((slot, i) => (
          <div className="anim-combine-row" key={slot.id}>
            <Port
              kind="in"
              flow="video"
              nodeId={node.id}
              portId={slot.id}
              portRef={helpers.portRef}
              title={`input ${i + 1}`}
            />
            <span className="anim-combine-slot">in {i + 1}</span>
            {mode === "stack" && (
              <input
                className="anim-combine-opacity"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={slot.opacity ?? 1}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  onGraphChange((g) =>
                    setCombineOpacity(g, node.id, slot.id, parseFloat(e.target.value))
                  )
                }
                title="layer opacity"
              />
            )}
            {inputs.length > 1 && (
              <button
                className="iconbtn anim-combine-rm"
                onClick={() => onGraphChange((g) => removeCombineInput(g, node.id, slot.id))}
                title="remove input"
              >
                ✕
              </button>
            )}
          </div>
        ))}
        <button
          className="btn sm anim-combine-add"
          onClick={() => onGraphChange((g) => addCombineInput(g, node.id))}
        >
          + input
        </button>
      </div>

      {/* Cross-segment continuity layer (data.layer): outputs sharing a layer number
          carry their composed simulation across segment cuts in the final export. */}
      <label
        className="ctl ctl-num anim-layer"
        title="cross-segment continuity — same layer number carries the composed simulation across segment cuts in the final export"
      >
        <span className="ctl-label">layer</span>
        <input
          type="number"
          min={1}
          step={1}
          value={d.layer ?? 1}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            const v = parseInt(e.target.value, 10);
            onGraphChange((g) => setCombineLayer(g, node.id, Number.isFinite(v) && v >= 1 ? v : 1));
          }}
        />
      </label>

      {mode === "merge" && (
        <div className="anim-combine-medium">
          <div className="anim-combine-medium-head">MEDIUM (shared)</div>
          {MEDIUM_KEYS.map((key) => {
            const p = fluidParam(key);
            const val = d.medium?.[key] ?? (p ? p.def : 0);
            return (
              <Ctl
                key={key}
                label={p ? p.label : key}
                value={val}
                min={p ? p.min : 0}
                max={p ? p.max : 1}
                step={p ? p.step : 0.01}
                fmt={p ? p.fmt : undefined}
                onChange={(v: number) => onGraphChange((g) => setCombineMedium(g, node.id, key, v))}
                {...argHelp("combine", key)}
              />
            );
          })}
        </div>
      )}
    </NodeFrame>
  );
}
