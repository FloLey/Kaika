import type { ChangeEvent } from "react";
import NodeFrame, { Port } from "./NodeFrame";
import ArgInfo from "./ArgInfo";
import StreamPreview from "./StreamPreview";
import { useNodeData } from "./useNodeData";
import { aspectOf } from "../../../lib/output";
import type { NodeProps } from "./nodeProps";
import type { ExtractData } from "../../../lib/types";

// The Extract card: one video in, one video out. It turns any video into a CONTROL
// IMAGE — canny edges or a soft-edge map — for feeding a ControlNet. Wire its output
// into AI Stylize's `control` input to guide the generation by the video's structure.
const KINDS: { id: ExtractData["kind"]; label: string }[] = [
  { id: "canny", label: "canny — hard edges" },
  { id: "soft", label: "soft edges" },
  { id: "density", label: "density — brightness (best for fluid)" },
  { id: "depth", label: "depth — model (real video, downloads)" },
];

export default function ExtractNode({
  node,
  selected,
  helpers,
  ctx,
  onGraphChange,
  onDelete,
}: NodeProps) {
  const d = node.data as ExtractData;
  const set = useNodeData<ExtractData>(node, onGraphChange);
  const kind = d.kind || "canny";

  return (
    <NodeFrame
      node={node}
      title="extract"
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
          title="control out — wire into AI Stylize's control input"
        />
      }
    >
      <StreamPreview node={node} ctx={ctx} aspect={ctx?.output ? aspectOf(ctx.output) : "1 / 1"} />

      <label className="anim-select-row">
        <span className="anim-select-label">kind</span>
        <ArgInfo type="extract" k="kind" />
        <select
          className="anim-select"
          value={kind}
          onChange={(e: ChangeEvent<HTMLSelectElement>) =>
            set({ kind: e.target.value as ExtractData["kind"] })
          }
        >
          {KINDS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      <div className="anim-combine-hint">
        white structure on black — a ControlNet map of the incoming video
      </div>
    </NodeFrame>
  );
}
