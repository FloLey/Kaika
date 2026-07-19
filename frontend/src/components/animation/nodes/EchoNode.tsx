import type { ChangeEvent } from "react";
import NodeFrame, { Port } from "./NodeFrame";
import { ParamRows } from "./FluidParamRow";
import ArgInfo from "./ArgInfo";
import StreamPreview from "./StreamPreview";
import { useNodeData } from "./useNodeData";
import { ctxAspect } from "../../../lib/output";
import { ECHO_PARAMS } from "../../../lib/nodeParams";
import type { NodeProps } from "./nodeProps";
import type { EchoData } from "../../../lib/types";

// The Echo look-FX card: one video in, one video out. Motion trails — a decayed
// memory of the past mixed back into the frame. Two memories: `ghost` is an
// exponential moving average, so every CHANGE leaves a fading afterimage (the
// classic echo on real footage, whatever the contrast); `bright` is a decayed
// running max, so bright-on-dark content leaves comet tails at full brightness
// and black stays black (the dye-on-black floor survives). `length` (half-life,
// seconds) and `amount` (dry↔trail mix) are modulatable ports — wire length to a
// signal and the trails stretch on every hit.
//
// Like every look-FX card it produces frames, not emitters — it can feed an output
// or a LAYERED combine, never a merge (which needs the raw fluid emitters).
const MODES: EchoData["mode"][] = ["ghost", "bright", "dark"];

export default function EchoNode({
  node,
  selected,
  helpers,
  ctx,
  onGraphChange,
  onDetach,
  onDelete,
}: NodeProps) {
  const d = node.data as EchoData;
  const set = useNodeData<EchoData>(node, onGraphChange);
  const mode = d.mode || "ghost";

  return (
    <NodeFrame
      node={node}
      title="echo"
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
        <ArgInfo type="echo" k="mode" />
        <select
          className="anim-select"
          value={mode}
          onChange={(e: ChangeEvent<HTMLSelectElement>) =>
            set({ mode: e.target.value as EchoData["mode"] })
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
        {mode === "ghost"
          ? "anything that moves leaves afterimages"
          : mode === "bright"
            ? "bright-on-dark leaves comet tails"
            : "dark-on-bright drags shadow trails"}
      </div>

      <ParamRows
        params={ECHO_PARAMS}
        node={node}
        helpers={helpers}
        onGraphChange={onGraphChange}
        onDetach={onDetach}
      />
    </NodeFrame>
  );
}
