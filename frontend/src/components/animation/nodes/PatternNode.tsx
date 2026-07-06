import { useMemo } from "react";
import type { ChangeEvent } from "react";
import NodeFrame, { Port } from "./NodeFrame";
import Ctl from "../../../ui/Ctl";
import ArgInfo from "./ArgInfo";
import PointsPad from "./PointsPad";
import { useNodeData } from "./useNodeData";
import { dp2 } from "./nodeConstants";
import { argHelp } from "../../../lib/paramHelp";
import { patternPoints } from "../../../lib/pointsGen";
import { aspectOf } from "../../../lib/output";
import type { NodeProps } from "./nodeProps";
import type { PatternData, PatternLayout } from "../../../lib/types";

// The pattern card: a parametric source layout (circle / ring / grid / line / spiral
// / scatter) instead of hand-placed points. Wire its output into a fluid's positions
// to emit one source per generated point. One `out` points port. v1 = static layout.
const LAYOUTS: PatternLayout[] = ["circle", "ring", "grid", "line", "spiral", "scatter"];

export default function PatternNode({ node, selected, helpers, ctx, onGraphChange, onDelete }: NodeProps) {
  const d = node.data as PatternData;
  const aspect = ctx?.output ? aspectOf(ctx.output) : "1 / 1";
  const pts = useMemo(() => patternPoints(d), [d]);
  const set = useNodeData<PatternData>(node, onGraphChange);

  return (
    <NodeFrame
      node={node}
      title="pattern"
      accent="var(--courant)"
      selected={selected}
      onTitlePointerDown={helpers.onTitlePointerDown}
      onDelete={onDelete}
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
      <PointsPad points={pts} aspect={aspect} />
      <label className="anim-select-row">
        <span className="anim-select-label">layout</span>
        <ArgInfo type="pattern" k="layout" />
        <select
          className="anim-select"
          value={d.layout}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => set({ layout: e.target.value as PatternLayout })}
        >
          {LAYOUTS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <Ctl
        label="count"
        value={d.count}
        min={1}
        max={64}
        step={1}
        fmt={(v) => `${v | 0}`}
        onChange={(v) => set({ count: v })}
        {...argHelp("pattern", "count")}
      />
      <Ctl
        label="radius"
        value={d.radius}
        min={0}
        max={0.5}
        step={0.01}
        fmt={dp2}
        onChange={(v) => set({ radius: v })}
        {...argHelp("pattern", "radius")}
      />
      <Ctl
        label="rotation"
        value={d.rotation}
        min={0}
        max={360}
        step={5}
        fmt={(v) => `${v | 0}°`}
        onChange={(v) => set({ rotation: v })}
        {...argHelp("pattern", "rotation")}
      />
      <Ctl
        label="offset x"
        value={d.offsetX ?? 0}
        min={-0.5}
        max={0.5}
        step={0.01}
        fmt={dp2}
        onChange={(v) => set({ offsetX: v })}
        {...argHelp("pattern", "offsetX")}
      />
      <Ctl
        label="offset y"
        value={d.offsetY ?? 0}
        min={-0.5}
        max={0.5}
        step={0.01}
        fmt={dp2}
        onChange={(v) => set({ offsetY: v })}
        {...argHelp("pattern", "offsetY")}
      />
      {d.layout === "scatter" && (
        <Ctl
          label="seed"
          value={d.seed}
          min={1}
          max={99}
          step={1}
          fmt={(v) => `#${v}`}
          onChange={(v) => set({ seed: v })}
          {...argHelp("pattern", "seed")}
        />
      )}
    </NodeFrame>
  );
}
