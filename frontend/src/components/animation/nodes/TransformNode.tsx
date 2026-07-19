import type { ChangeEvent } from "react";
import NodeFrame, { Port } from "./NodeFrame";
import Ctl, { Toggle } from "../../../ui/Ctl";
import { ParamRows } from "./FluidParamRow";
import ArgInfo from "./ArgInfo";
import StreamPreview from "./StreamPreview";
import { useNodeData } from "./useNodeData";
import { argHelp } from "../../../lib/paramHelp";
import { ctxAspect } from "../../../lib/output";
import { TRANSFORM_PARAMS } from "../../../lib/nodeParams";
import type { NodeProps } from "./nodeProps";
import type { TransformData } from "../../../lib/types";

// The transform video-FX card: one video in, one video out. It warps the incoming
// frames — zoom / rotate / pan are modulatable ports (wire rotate to a signal and the
// whole frame spins on the beat), and the mode optionally folds the result into a
// mirror or a kaleidoscope. Sampling outside the frame stays black unless `wrap` tiles
// it, so the dye-on-black floor (and everything that composites on it) survives.
//
// It produces frames, not emitters, so it can feed an output or a LAYERED combine —
// never a merge (which needs the raw fluid emitters).
//
// The mode is a `<select>`, not the segmented buttons the combine card uses: three
// options — one of them the 12-character "kaleidoscope" — can't shrink below their
// min-content inside a 230px card, so buttons overflowed its right edge.
const MODES: TransformData["mode"][] = ["transform", "mirror", "kaleidoscope"];

export default function TransformNode({
  node,
  selected,
  helpers,
  ctx,
  onGraphChange,
  onDetach,
  onDelete,
}: NodeProps) {
  const d = node.data as TransformData;
  const set = useNodeData<TransformData>(node, onGraphChange);
  const mode = d.mode || "transform";

  return (
    <NodeFrame
      node={node}
      title="transform"
      accent="var(--fx)"
      selected={selected}
      onTitlePointerDown={helpers.onTitlePointerDown}
      onDelete={onDelete}
      sideIn={
        <Port
          kind="in"
          flow="video"
          nodeId={node.id}
          portId="video"
          portRef={helpers.portRef}
          title="video in"
        />
      }
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
      <StreamPreview node={node} ctx={ctx} aspect={ctxAspect(ctx)} />

      <label className="anim-select-row">
        <span className="anim-select-label">mode</span>
        <ArgInfo type="transform" k="mode" />
        <select
          className="anim-select"
          value={mode}
          onChange={(e: ChangeEvent<HTMLSelectElement>) =>
            set({ mode: e.target.value as TransformData["mode"] })
          }
        >
          {MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      <div className="anim-combine-hint">
        {mode === "transform"
          ? "pan, zoom and rotate the video"
          : mode === "mirror"
            ? "reflect one half across the centre"
            : `fold into ${d.segments ?? 6} mirrored wedges`}
      </div>

      <div className="anim-static">
        {mode === "kaleidoscope" && (
          <Ctl
            label="segments"
            value={d.segments ?? 6}
            min={2}
            max={12}
            step={1}
            onChange={(v) => set({ segments: Math.round(v) })}
            {...argHelp("transform", "segments")}
          />
        )}
        <Toggle
          label="wrap edges"
          value={!!d.wrap}
          onChange={(v) => set({ wrap: v })}
          {...argHelp("transform", "wrap")}
        />
      </div>

      <ParamRows
        params={TRANSFORM_PARAMS}
        node={node}
        helpers={helpers}
        onGraphChange={onGraphChange}
        onDetach={onDetach}
      />
    </NodeFrame>
  );
}
