import NodeFrame, { Port } from "./NodeFrame";
import Ctl from "../../../ui/Ctl";
import ArgInfo from "./ArgInfo";
import ValuePreview from "./ValuePreview";
import { useNodeData } from "./useNodeData";
import { dp2 } from "./nodeConstants";
import { argHelp } from "../../../lib/paramHelp";
import type { NodeProps } from "./nodeProps";
import type { ChangeData } from "../../../lib/types";

// The change card: any 0..1 value in → how fast it's CHANGING out (its smoothed
// |derivative|, units/second). Where the gate asks "is the signal HIGH?", change asks
// "is the signal MOVING?" — so signal → change → gate → montage.trigger cuts on
// musical transitions (verse→chorus, drops, chord changes on a chroma signal) instead
// of on level. Fast attack + slow release turn a burst of movement into one clean
// bump the downstream gate can threshold. Input `in` (value) → `out` (value).
const DIRECTIONS: ChangeData["direction"][] = ["both", "rise", "fall"];

export default function ChangeNode({
  node,
  selected,
  helpers,
  ctx,
  onGraphChange,
  onDelete,
}: NodeProps) {
  const d = node.data as ChangeData;
  const set = useNodeData<ChangeData>(node, onGraphChange);

  return (
    <NodeFrame
      node={node}
      title="change"
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
          title="change rate out"
        />
      }
    >
      <div className="anim-mod">
        <ValuePreview node={node} ctx={ctx} />
        <Ctl
          label="gain"
          value={d.gain ?? 1}
          min={0}
          max={10}
          step={0.1}
          fmt={dp2}
          onChange={(v) => set({ gain: v })}
          {...argHelp("change", "gain")}
        />
        <Ctl
          label="attack"
          value={d.attack ?? 5}
          min={0}
          max={500}
          step={5}
          fmt={(v) => `${Math.round(v)}ms`}
          onChange={(v) => set({ attack: v })}
          {...argHelp("change", "attack")}
        />
        <Ctl
          label="release"
          value={d.release ?? 400}
          min={0}
          max={2000}
          step={10}
          fmt={(v) => `${Math.round(v)}ms`}
          onChange={(v) => set({ release: v })}
          {...argHelp("change", "release")}
        />
        <label className="anim-select-row">
          <span className="anim-select-label">direction</span>
          <ArgInfo type="change" k="direction" />
          <select
            className="anim-select"
            value={d.direction || "both"}
            onChange={(e) => set({ direction: e.target.value as ChangeData["direction"] })}
          >
            {DIRECTIONS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
      </div>
    </NodeFrame>
  );
}
