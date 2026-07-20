import NodeFrame, { Port } from "./NodeFrame";
import PointsPad from "./PointsPad";
import { useResolvedPoints } from "./useResolvedPoints";
import { addInputPort, removeInputPort, upstreamKey } from "../../../lib/graphModel";
import { ctxAspect } from "../../../lib/output";
import type { NodeProps } from "./nodeProps";
import type { MergePointsData } from "../../../lib/types";

// The merge-points card: concatenates 2+ points inputs into one set (e.g. two Pattern
// cards → one fluid's positions). Inputs are ordered points-edge slots targeted by
// port id — the backend (`_resolve_points`) resolves each and appends them (capped at
// the emitter limit). One `out` points port. The preview is the REAL merged scatter.
export default function MergePointsNode({
  node,
  selected,
  helpers,
  ctx,
  onGraphChange,
  onDelete,
}: NodeProps) {
  const d = node.data as MergePointsData;
  const inputs = d.inputs || [];
  const aspect = ctxAspect(ctx);
  const depKey = ctx?.graph ? upstreamKey(ctx.graph, node.id, ctx?.segment?.signals) : "";
  const { points } = useResolvedPoints(ctx, node.id, depKey);

  return (
    <NodeFrame
      node={node}
      title="merge points"
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
      <PointsPad points={points} aspect={aspect} />
      <div className="anim-math-inputs">
        {inputs.map((portId, i) => (
          <div className="anim-math-row" key={portId}>
            <Port
              kind="in"
              flow="points"
              nodeId={node.id}
              portId={portId}
              portRef={helpers.portRef}
              title={`points ${i + 1}`}
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
    </NodeFrame>
  );
}
