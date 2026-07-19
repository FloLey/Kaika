import type { ChangeEvent, CSSProperties } from "react";
import NodeFrame, { Port } from "./NodeFrame";
import { ParamRow } from "./FluidParamRow";
import ArgInfo from "./ArgInfo";
import { setConstValue } from "./fluidBindings";
import { useNodeData } from "./useNodeData";
import { COLOR_PARAMS } from "../../../lib/nodeParams";
import type { NodeProps } from "./nodeProps";
import type { ColorData, ColorMode, ColorStop } from "../../../lib/types";

// The colour source card — sets the fluid's dye colour, wired into a fluid's `color`
// input. Three modes: swatch (a solid colour), rgb (per-channel modulatable rows),
// gradient (colour stops + a modulatable `position` that scrubs along them).
const MODES: ColorMode[] = ["swatch", "rgb", "gradient"];
const RGB = COLOR_PARAMS.filter((p) => p.key === "r" || p.key === "g" || p.key === "b");
const LEVELS = COLOR_PARAMS.filter((p) => p.key === "intensity" || p.key === "opacity");
const POSITION = COLOR_PARAMS.find((p) => p.key === "position")!;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const hex2 = (v: number) =>
  Math.round(clamp01(v) * 255)
    .toString(16)
    .padStart(2, "0");
const toHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
const fromHex = (h: string): [number, number, number] => {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const def = (k: string) => COLOR_PARAMS.find((p) => p.key === k)?.def ?? 0;

export default function ColorNode({
  node,
  selected,
  helpers,
  onGraphChange,
  onDetach,
  onDelete,
}: NodeProps) {
  const d = node.data as ColorData;
  const detach = (key: string) => onDetach?.(node.id, key);
  const patch = useNodeData<ColorData>(node, onGraphChange);

  // ---- swatch: read/write the r/g/b const ports --------------------------------
  const constVal = (key: string) => {
    const b = d.ports[key]?.binding;
    return b && b.kind === "const" ? b.value : def(key);
  };
  const onSwatch = (hex: string) => {
    const [r, g, b] = fromHex(hex);
    onGraphChange((g0) => {
      let ng = setConstValue(node.id, "r", r)(g0);
      ng = setConstValue(node.id, "g", g)(ng);
      ng = setConstValue(node.id, "b", b)(ng);
      return ng;
    });
  };

  // ---- gradient: stop list edits ----------------------------------------------
  const stops = d.stops || [];
  const setStops = (next: ColorStop[]) => patch({ stops: next });
  const updateStop = (i: number, p: Partial<ColorStop>) =>
    setStops(stops.map((s, k) => (k === i ? { ...s, ...p } : s)));
  const addStop = () => setStops([...stops, { t: 0.5, color: "#ffffff" }]);
  const removeStop = (i: number) => setStops(stops.filter((_, k) => k !== i));
  const gradientCss = [...stops]
    .sort((a, b) => a.t - b.t)
    .map((s) => `${s.color} ${Math.round(clamp01(s.t) * 100)}%`)
    .join(", ");

  const rowsFor = (params: typeof LEVELS) =>
    params.map((p) => (
      <ParamRow
        key={p.key}
        node={node}
        param={p}
        helpers={helpers}
        onGraphChange={onGraphChange}
        onDetach={detach}
      />
    ));

  return (
    <NodeFrame
      node={node}
      title="color"
      accent="var(--petale)"
      selected={selected}
      onTitlePointerDown={helpers.onTitlePointerDown}
      onDelete={onDelete}
      sideOut={
        <Port
          kind="out"
          flow="color"
          nodeId={node.id}
          portId="out"
          portRef={helpers.portRef}
          startConnect={helpers.startConnect}
          title="colour out — wire into a fluid's color input"
        />
      }
    >
      <div className="anim-static">
        <label className="anim-select-row">
          <span className="anim-select-label">mode</span>
          <ArgInfo type="color" k="mode" />
          <select
            className="anim-select"
            value={d.mode}
            onChange={(e: ChangeEvent<HTMLSelectElement>) =>
              patch({ mode: e.target.value as ColorMode })
            }
          >
            {MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
      </div>

      {d.mode === "swatch" && (
        <div className="anim-color-swatch">
          <input
            type="color"
            value={toHex(constVal("r"), constVal("g"), constVal("b"))}
            onChange={(e) => onSwatch(e.target.value)}
            title="colour"
          />
          <span className="anim-param-label">colour</span>
        </div>
      )}

      {d.mode === "rgb" && rowsFor(RGB)}

      {d.mode === "gradient" && (
        <div className="anim-gradient">
          <div
            className="anim-gradient-bar"
            style={{ "--grad": `linear-gradient(90deg, ${gradientCss})` } as CSSProperties}
          />
          {stops.map((s, i) => (
            <div className="anim-gradient-stop" key={i}>
              <input
                type="color"
                value={s.color}
                onChange={(e) => updateStop(i, { color: e.target.value })}
                title="stop colour"
              />
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={s.t}
                onChange={(e) => updateStop(i, { t: parseFloat(e.target.value) })}
                title="stop position"
              />
              <span className="anim-gradient-t">{Math.round(s.t * 100)}%</span>
              <button
                className="iconbtn sm"
                title="remove stop"
                disabled={stops.length <= 2}
                onClick={() => removeStop(i)}
              >
                ✕
              </button>
            </div>
          ))}
          <button className="btn sm" onClick={addStop}>
            + stop
          </button>
          <ParamRow
            node={node}
            param={POSITION}
            helpers={helpers}
            onGraphChange={onGraphChange}
            onDetach={detach}
          />
        </div>
      )}

      {rowsFor(LEVELS)}
    </NodeFrame>
  );
}
