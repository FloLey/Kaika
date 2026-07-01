import type { ChangeEvent } from "react";
import NodeFrame, { Port } from "./NodeFrame";
import Ctl from "../../../ui/Ctl";
import ArgInfo from "./ArgInfo";
import { patchNodeData } from "../../../lib/graphModel";
import { argHelp } from "../../../lib/paramHelp";
import type { NodeProps } from "./nodeProps";
import type { AnimatePointsData, AnimatePointsMode } from "../../../lib/types";

// The animate-points card: move an incoming points set over the clip. orbit = each
// point circles the centre; drift = each point slides along a heading and loops back.
// chase = the points stay put and a SNAKE of `length` points glides around the set at
// `speed` (one loop per segment at 1×): a bright head with a tail that fades by `taper`.
// orbit/drift reuse the fluid's per-source path machinery; chase rides its per-source
// emission gate. Both are part of the render. Input `in` (points) → `out` (points).
const MODES: AnimatePointsMode[] = ["orbit", "drift", "chase"];

export default function AnimatePointsNode({ node, selected, helpers, onGraphChange, onDelete }: NodeProps) {
  const d = node.data as AnimatePointsData;
  const set = (patch: Partial<AnimatePointsData>) =>
    onGraphChange((g) => patchNodeData(g, node.id, patch as Record<string, unknown>));

  return (
    <NodeFrame
      node={node}
      title="animate"
      accent="var(--courant)"
      selected={selected}
      onTitlePointerDown={helpers.onTitlePointerDown}
      onDelete={onDelete}
      sideIn={
        <Port
          kind="in"
          flow="points"
          nodeId={node.id}
          portId="in"
          portRef={helpers.portRef}
          title="points in"
        />
      }
      sideOut={
        <Port
          kind="out"
          flow="points"
          nodeId={node.id}
          portId="out"
          portRef={helpers.portRef}
          startConnect={helpers.startConnect}
          title="points out"
        />
      }
    >
      <label className="anim-select-row">
        <span className="anim-select-label">motion</span>
        <ArgInfo type="animate-points" k="mode" />
        <select
          className="anim-select"
          value={d.mode}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => set({ mode: e.target.value as AnimatePointsMode })}
        >
          {MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      {d.mode !== "chase" && (
        <Ctl
          label="amount"
          value={d.amount}
          min={0}
          max={0.5}
          step={0.01}
          fmt={(v) => v.toFixed(2)}
          onChange={(v) => set({ amount: v })}
          {...argHelp("animate-points", "amount")}
        />
      )}
      <Ctl
        label={d.mode === "chase" ? "speed" : "rate"}
        value={d.rate}
        min={0.1}
        max={8}
        step={0.1}
        fmt={(v) => `${v.toFixed(1)}×`}
        onChange={(v) => set({ rate: v })}
        {...argHelp("animate-points", "rate")}
      />
      {d.mode === "drift" && (
        <Ctl
          label="heading"
          value={d.angle}
          min={0}
          max={360}
          step={5}
          fmt={(v) => `${v | 0}°`}
          onChange={(v) => set({ angle: v })}
          {...argHelp("animate-points", "angle")}
        />
      )}
      {d.mode === "chase" && (
        <>
          <Ctl
            label="length"
            value={d.count}
            min={1}
            max={16}
            step={1}
            fmt={(v) => `${v | 0}`}
            onChange={(v) => set({ count: v })}
            {...argHelp("animate-points", "count")}
          />
          <Ctl
            label="taper"
            value={d.fade}
            min={0}
            max={1}
            step={0.05}
            fmt={(v) => v.toFixed(2)}
            onChange={(v) => set({ fade: v })}
            {...argHelp("animate-points", "fade")}
          />
        </>
      )}
    </NodeFrame>
  );
}
