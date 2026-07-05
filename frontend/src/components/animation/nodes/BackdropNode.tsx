import type { ChangeEvent } from "react";
import NodeFrame, { Port } from "./NodeFrame";
import { ParamRow } from "./FluidParamRow";
import ArgInfo from "./ArgInfo";
import { useNodeData } from "./useNodeData";
import { BACKDROP_PARAMS } from "../../../lib/nodeParams";
import type { NodeProps } from "./nodeProps";
import type { BackdropData } from "../../../lib/types";

// Backdrop source: a full-frame solid-colour fill, output as a video layer. Wire it into
// the BOTTOM input of a stack combine to get a non-black background in the final render.
// The colour is a static swatch; `opacity` is the only modulatable port.
export default function BackdropNode({ node, selected, helpers, onGraphChange, onDetach, onDelete }: NodeProps) {
  const d = node.data as BackdropData;
  const set = useNodeData<BackdropData>(node, onGraphChange);

  return (
    <NodeFrame
      node={node}
      title="backdrop"
      accent="var(--courant)"
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
      <div className="anim-color-swatch">
        <input
          type="color"
          value={d.color}
          onChange={(e: ChangeEvent<HTMLInputElement>) => set({ color: e.target.value })}
          title="backdrop colour"
        />
        <span className="anim-param-label">colour</span>
        <ArgInfo type="backdrop" k="color" />
      </div>
      {BACKDROP_PARAMS.map((p) => (
        <ParamRow
          key={p.key}
          node={node}
          param={p}
          helpers={helpers}
          onGraphChange={onGraphChange}
          onDetach={(key) => onDetach?.(node.id, key)}
        />
      ))}
    </NodeFrame>
  );
}
