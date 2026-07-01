import { useMemo } from "react";
import NodeFrame, { Port } from "./NodeFrame";
import Ctl, { Toggle } from "../../../ui/Ctl";
import MiniSpark from "./MiniSpark";
import { patchNodeData } from "../../../lib/graphModel";
import { argHelp } from "../../../lib/paramHelp";
import { shaperPreview } from "../../../lib/modPreview";
import type { NodeProps } from "./nodeProps";
import type { ShaperData } from "../../../lib/types";

// The shaper / remap card: re-curve ONE value per use (sharpen, soften, invert,
// remap its range) without touching the studio signal it came from. Reuses the exact
// studio shaping order on the backend. Input `in` (value) → `out` (value). The
// preview shows the static transfer curve (the attack/release follower shapes timing,
// not level, so it isn't drawn).
export default function ShaperNode({
  node,
  selected,
  helpers,
  onGraphChange,
  onDelete,
}: NodeProps) {
  const d = node.data as ShaperData;
  const preview = useMemo(() => shaperPreview(d), [d]);
  const set = (patch: Partial<ShaperData>) =>
    onGraphChange((g) => patchNodeData(g, node.id, patch as Record<string, unknown>));

  return (
    <NodeFrame
      node={node}
      title="shaper"
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
          title="value out"
        />
      }
    >
      <div className="anim-mod">
        <MiniSpark values={preview} />
        <Ctl
          label="delay"
          value={d.delay}
          min={0}
          max={2000}
          step={1}
          fmt={(v) => `${v | 0}ms`}
          onChange={(v) => set({ delay: v })}
          {...argHelp("shaper", "delay")}
        />
        <Toggle
          label="wrap"
          value={d.wrap}
          onChange={(v) => set({ wrap: v })}
          {...argHelp("shaper", "wrap")}
        />
        <Toggle
          label="invert"
          value={d.invert}
          onChange={(v) => set({ invert: v })}
          {...argHelp("shaper", "invert")}
        />
        <Ctl
          label="attack"
          value={d.attack}
          min={0}
          max={1000}
          step={1}
          fmt={(v) => `${v | 0}ms`}
          onChange={(v) => set({ attack: v })}
          {...argHelp("shaper", "attack")}
        />
        <Ctl
          label="release"
          value={d.release}
          min={0}
          max={2000}
          step={1}
          fmt={(v) => `${v | 0}ms`}
          onChange={(v) => set({ release: v })}
          {...argHelp("shaper", "release")}
        />
        <Ctl
          label="threshold"
          value={d.threshold}
          min={0}
          max={0.9}
          step={0.01}
          fmt={(v) => v.toFixed(2)}
          onChange={(v) => set({ threshold: v })}
          {...argHelp("shaper", "threshold")}
        />
        <Ctl
          label="gamma"
          value={d.gamma}
          min={0.2}
          max={4}
          step={0.05}
          fmt={(v) => v.toFixed(2)}
          onChange={(v) => set({ gamma: v })}
          {...argHelp("shaper", "gamma")}
        />
        <Ctl
          label="gain"
          value={d.gain}
          min={0}
          max={2}
          step={0.05}
          fmt={(v) => v.toFixed(2)}
          onChange={(v) => set({ gain: v })}
          {...argHelp("shaper", "gain")}
        />
        <Ctl
          label="offset"
          value={d.offset}
          min={-0.5}
          max={0.5}
          step={0.01}
          fmt={(v) => v.toFixed(2)}
          onChange={(v) => set({ offset: v })}
          {...argHelp("shaper", "offset")}
        />
        <div className="anim-mod-remap">
          <span className="anim-mod-remap-label">out range</span>
          <Ctl
            label="lo"
            value={d.lo}
            min={0}
            max={1}
            step={0.01}
            fmt={(v) => v.toFixed(2)}
            onChange={(v) => set({ lo: Math.min(v, d.hi) })}
            {...argHelp("shaper", "lo")}
          />
          <Ctl
            label="hi"
            value={d.hi}
            min={0}
            max={1}
            step={0.01}
            fmt={(v) => v.toFixed(2)}
            onChange={(v) => set({ hi: Math.max(v, d.lo) })}
            {...argHelp("shaper", "hi")}
          />
        </div>
      </div>
    </NodeFrame>
  );
}
