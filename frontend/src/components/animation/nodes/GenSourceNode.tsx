import type { ChangeEvent } from "react";
import NodeFrame, { Port } from "./NodeFrame";
import { ParamRow } from "./FluidParamRow";
import ArgInfo from "./ArgInfo";
import { useNodeData } from "./useNodeData";
import { videoSource } from "../../../lib/graphModel";
import type { FluidParam } from "../../../lib/types";
import type { NodeProps } from "./nodeProps";

// The generative simulation cards (waves / lightning / fire / aurora / rain / clouds)
// share one shell: a `palette` preset select + an optional `color` card override input
// + the behavioural ports. Per-card extras: `videoIn` (waves/rain — the layer the
// water REFRACTS; without it the card renders onto its palette) and `positionsIn`
// (fire/lightning/rain — a points card fans the card out to several origins, exactly
// like fluid emitters). Colour is NOT a port — it's the palette or, when a `color`
// card is wired into "color", that card's ramp (see graph_render).
interface GenData {
  palette: string;
  seed: number;
}

export function makeGenSourceNode(cfg: {
  type: string;
  title: string;
  accent: string;
  params: FluidParam[];
  palettes: string[];
  videoIn?: string; // tooltip for the optional refracted video input
  positionsIn?: string; // tooltip for the optional points-card input
}) {
  function GenSourceNode({ node, selected, helpers, ctx, onGraphChange, onDetach, onDelete }: NodeProps) {
    const d = node.data as GenData;
    const set = useNodeData<GenData>(node, onGraphChange);
    const colorWired = !!(ctx?.graph && videoSource(ctx.graph, node.id, "color"));
    const videoWired = !!(cfg.videoIn && ctx?.graph && videoSource(ctx.graph, node.id, "video"));
    const posWired = !!(cfg.positionsIn && ctx?.graph && videoSource(ctx.graph, node.id, "positions"));

    return (
      <NodeFrame
        node={node}
        title={cfg.title}
        accent={cfg.accent}
        selected={selected}
        onTitlePointerDown={helpers.onTitlePointerDown}
        onDelete={onDelete}
        sideIn={
          cfg.videoIn ? (
            <Port
              kind="in"
              flow="video"
              nodeId={node.id}
              portId="video"
              portRef={helpers.portRef}
              title={cfg.videoIn}
            />
          ) : undefined
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
        <label className="anim-select-row">
          <span className="anim-select-label">palette</span>
          <ArgInfo type={cfg.type} k="palette" />
          <select
            className="anim-select"
            value={d.palette}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => set({ palette: e.target.value })}
          >
            {cfg.palettes.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>

        {/* Optional colour override: wire a `color` card here (a gradient card supplies
            the whole ramp) to replace the preset palette. */}
        <div className="anim-pos-row">
          <Port
            kind="in"
            flow="color"
            nodeId={node.id}
            portId="color"
            portRef={helpers.portRef}
            title="wire a color card here to override the palette"
          />
          <span className="anim-pos-label">color</span>
          <ArgInfo type={cfg.type} k="color" />
          <span className="anim-pos-count">{colorWired ? "wired" : "palette"}</span>
        </div>

        {cfg.videoIn && (
          <div className="anim-pos-row">
            <span className="anim-pos-label">video</span>
            <ArgInfo type={cfg.type} k="video" />
            <span className="anim-pos-count">{videoWired ? "refracting input" : "palette floor"}</span>
          </div>
        )}

        {cfg.positionsIn && (
          <div className="anim-pos-row">
            <Port
              kind="in"
              flow="points"
              nodeId={node.id}
              portId="positions"
              portRef={helpers.portRef}
              title={cfg.positionsIn}
            />
            <span className="anim-pos-label">positions</span>
            <ArgInfo type={cfg.type} k="positions" />
            <span className="anim-pos-count">{posWired ? "points" : "origin ports"}</span>
          </div>
        )}

        {cfg.params.map((p) => (
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
  GenSourceNode.displayName = `GenSourceNode(${cfg.type})`;
  return GenSourceNode;
}
