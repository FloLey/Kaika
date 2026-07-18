import { useMemo } from "react";
import type { ChangeEvent } from "react";
import NodeFrame, { Port } from "./NodeFrame";
import { ParamRow } from "./FluidParamRow";
import ArgInfo from "./ArgInfo";
import StreamPreview from "./StreamPreview";
import { useNodeData } from "./useNodeData";
import { aspectOf } from "../../../lib/output";
import { videoSource } from "../../../lib/graphModel";
import { COLORGRADE_PARAMS } from "../../../lib/nodeParams";
import type { NodeProps } from "./nodeProps";
import type { ColorGradeData } from "../../../lib/types";

// The Color Grade look-FX card: one video in, one video out. Recolours the stream:
// `thermal` maps luminance through a heat colormap, `duotone` onto a two-colour ramp
// (poster look), `neon` draws glowing edges on black. A `color` card wired into the
// `tint` input drives the grade colour — a gradient tint with a bound `position`
// sweeps it with the music; unwired, the swatches apply. `intensity` (dry↔graded /
// glow gain) and `shift` (LUT roll / midpoint / hue) are modulatable ports.
//
// thermal (turbo/jet/ocean) and duotone recolour the black floor by design — grade
// modes belong at the END of the chain (feeding the output or the bottom of a stack).
// neon keeps black black. Like every look-FX card it produces frames, not emitters —
// it feeds an output or a LAYERED combine, never a merge.
const MODES: ColorGradeData["mode"][] = ["thermal", "duotone", "neon"];
const MAPS: ColorGradeData["map"][] = ["turbo", "inferno", "jet", "ocean"];

export default function ColorGradeNode({
  node,
  selected,
  helpers,
  ctx,
  onGraphChange,
  onDetach,
  onDelete,
}: NodeProps) {
  const d = node.data as ColorGradeData;
  const set = useNodeData<ColorGradeData>(node, onGraphChange);
  const mode = d.mode || "thermal";
  const tintWired = useMemo(
    () => !!(ctx?.graph && videoSource(ctx.graph, node.id, "tint")),
    [ctx?.graph, node.id]
  );

  return (
    <NodeFrame
      node={node}
      title="color grade"
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
      <StreamPreview node={node} ctx={ctx} aspect={ctx?.output ? aspectOf(ctx.output) : "1 / 1"} />

      <label className="anim-select-row">
        <span className="anim-select-label">mode</span>
        <ArgInfo type="colorgrade" k="mode" />
        <select
          className="anim-select"
          value={mode}
          onChange={(e: ChangeEvent<HTMLSelectElement>) =>
            set({ mode: e.target.value as ColorGradeData["mode"] })
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
        {mode === "thermal"
          ? "heat-camera false colour"
          : mode === "duotone"
            ? "two-colour poster remap"
            : "glowing edges on black"}
      </div>

      {/* Wire a color card here to drive the grade colour (duotone highlight / neon
          glow); a gradient with a bound position sweeps it with the music. */}
      <div className="anim-pos-row">
        <Port
          kind="in"
          flow="color"
          nodeId={node.id}
          portId="tint"
          portRef={helpers.portRef}
          title="wire a color card to drive the grade colour"
        />
        <span className="anim-pos-label">tint</span>
        <span className="anim-pos-count">{tintWired ? "wired" : "swatch"}</span>
      </div>

      <div className="anim-static">
        {mode === "thermal" && (
          <label className="anim-select-row">
            <span className="anim-select-label">map</span>
            <ArgInfo type="colorgrade" k="map" />
            <select
              className="anim-select"
              value={d.map || "turbo"}
              onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                set({ map: e.target.value as ColorGradeData["map"] })
              }
            >
              {MAPS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        )}
        {mode === "duotone" && (
          <div className="anim-color-swatch">
            <input
              type="color"
              value={d.colorA || "#0b1030"}
              onChange={(e: ChangeEvent<HTMLInputElement>) => set({ colorA: e.target.value })}
              title="shadow colour"
            />
            <span className="anim-param-label">shadow</span>
            <ArgInfo type="colorgrade" k="colorA" />
          </div>
        )}
        {mode !== "thermal" && !tintWired && (
          <div className="anim-color-swatch">
            <input
              type="color"
              value={d.colorB || "#ff5ac8"}
              onChange={(e: ChangeEvent<HTMLInputElement>) => set({ colorB: e.target.value })}
              title={mode === "duotone" ? "highlight colour" : "glow colour"}
            />
            <span className="anim-param-label">{mode === "duotone" ? "highlight" : "glow"}</span>
            <ArgInfo type="colorgrade" k="colorB" />
          </div>
        )}
      </div>

      {COLORGRADE_PARAMS.map((p) => (
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
