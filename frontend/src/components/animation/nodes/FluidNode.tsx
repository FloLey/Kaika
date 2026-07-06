import { useEffect, useMemo, useState } from "react";
import { Toggle } from "../../../ui/Ctl";
import NodeFrame, { Port } from "./NodeFrame";
import { argHelp } from "../../../lib/paramHelp";
import { FLUID_PARAMS as RAW_FLUID_PARAMS } from "../../../lib/fluidParams.js";
import { videoSource } from "../../../lib/graphModel";
import { aspectOf } from "../../../lib/output";
import StreamPreview from "./StreamPreview";
import { patchStatic, setFluidLayer } from "./fluidBindings";
import { ParamRow, GroupAnchor } from "./FluidParamRow";
import type { NodeProps } from "./nodeProps";
import type { FluidData, FluidParam } from "../../../lib/types";

const FLUID_PARAMS = RAW_FLUID_PARAMS as FluidParam[];

// The artifact card (06 §FluidNode). Static controls on top; one input-port ROW
// per FLUID_PARAMS entry, grouped source/color/medium (rows + the collapsed-group
// anchor live in FluidParamRow.jsx). One `out` video port (→ OutputNode). Groups
// collapse to stay tidy.
//
// PATH: v1 uses a SIMPLIFIED static path — a single center point plus the radial
// toggle (per 06's recommendation).

// COLOR is no longer a fluid group — the dye colour was extracted into a standalone
// `color` card wired into the fluid's `color` input (see the color-input row below).
const GROUPS = [
  { key: "source", label: "SOURCE" },
  { key: "medium", label: "MEDIUM" },
];

export default function FluidNode({
  node,
  selected,
  helpers,
  ctx,
  onGraphChange,
  onDetach,
  onDelete,
}: NodeProps) {
  const data = node.data as FluidData; // this card only renders for a fluid node
  const [open, setOpen] = useState<Record<string, boolean>>({
    source: true,
    medium: false,
  });
  const s = data.static;

  // A wired points card overrides the single-centre source with N source positions.
  // Memoized so this graph walk doesn't re-run on every unrelated re-render.
  const posCount = useMemo(() => {
    const g = ctx?.graph;
    if (!g) return 0;
    const srcId = videoSource(g, node.id, "positions");
    const pn = srcId ? g.nodes.find((n) => n.id === srcId) : null;
    return pn && pn.type === "points" ? (pn.data.points || []).length : 0;
  }, [ctx?.graph, node.id]);

  // Whether a `color` card is wired into the dye-colour input (else the fluid uses its
  // static default colour).
  const colorWired = useMemo(
    () => !!(ctx?.graph && videoSource(ctx.graph, node.id, "color")),
    [ctx?.graph, node.id]
  );

  // Collapsing/expanding a group mounts/unmounts ports; ask the canvas to redraw
  // edges so wires re-anchor (to the group header when collapsed, to the row port
  // when open). `onLayoutChange` is stable, so this only fires when `open` flips.
  const { onLayoutChange } = helpers;
  useEffect(() => {
    onLayoutChange?.();
  }, [open, onLayoutChange]);

  const setStatic = (patch: Record<string, unknown>) => onGraphChange(patchStatic(node.id, patch));
  // Cross-segment continuity layer (data.layer). Clamped to a positive integer; the
  // final export carries a layer's simulation forward across segment cuts.
  const setLayer = (v: number) =>
    onGraphChange(setFluidLayer(node.id, Number.isFinite(v) && v >= 1 ? Math.round(v) : 1));

  const detach = (key: string) => onDetach?.(node.id, key);

  return (
    <NodeFrame
      node={node}
      title="fluid"
      accent="var(--petale)"
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
      {/* Live sim preview — the fluid's own dye-on-transparent output, streamed. */}
      <StreamPreview node={node} ctx={ctx} aspect={ctx?.output ? aspectOf(ctx.output) : "1 / 1"} />
      {/* Source positions: a labelled `points` input. Wire a points card here to put
          a source at each drawn point (otherwise a single source at the centre). */}
      <div className="anim-pos-row">
        <Port
          kind="in"
          flow="points"
          nodeId={node.id}
          portId="positions"
          portRef={helpers.portRef}
          title="wire a points card here"
        />
        <span className="anim-pos-label">positions</span>
        <span className="anim-pos-count">
          {posCount > 0 ? `${posCount} point${posCount === 1 ? "" : "s"}` : "center"}
        </span>
      </div>

      {/* Dye colour: wire a `color` card here to drive r/g/b + intensity/opacity;
          otherwise the fluid uses its static default colour. */}
      <div className="anim-pos-row">
        <Port
          kind="in"
          flow="color"
          nodeId={node.id}
          portId="color"
          portRef={helpers.portRef}
          title="wire a color card here"
        />
        <span className="anim-pos-label">color</span>
        <span className="anim-pos-count">{colorWired ? "wired" : "default"}</span>
      </div>

      {/* Static controls (non-port params). The clip always spans the full segment,
          so there is no duration control. */}
      <div className="anim-static">
        <Toggle
          label="enabled"
          value={s.enabled}
          onChange={(v: boolean) => setStatic({ enabled: v })}
          {...argHelp("fluid", "enabled")}
        />
        <Toggle
          label="radial"
          value={s.radial}
          onChange={(v: boolean) => setStatic({ radial: v })}
          {...argHelp("fluid", "radial")}
        />
        <Toggle
          label="wrap edges"
          value={s.wrap !== false}
          onChange={(v: boolean) => setStatic({ wrap: v })}
          {...argHelp("fluid", "wrap")}
        />
        {(s.radial || s.wrap === false) && (
          <div className="anim-path-note">
            {s.radial ? "radial" : ""}
            {s.radial && s.wrap === false ? " · " : ""}
            {s.wrap === false ? "open edges" : ""}
          </div>
        )}
        <label className="ctl ctl-num anim-layer" title="cross-segment continuity — outputs sharing a layer number carry their simulation across segment cuts in the final export">
          <span className="ctl-label">layer</span>
          <input
            type="number"
            min={1}
            step={1}
            value={data.layer ?? 1}
            onChange={(e) => setLayer(parseInt(e.target.value, 10))}
          />
        </label>
      </div>

      {/* Param input ports, grouped + collapsible. */}
      {GROUPS.map((grp) => {
        const params = FLUID_PARAMS.filter((p) => p.group === grp.key);
        const isOpen = open[grp.key];
        const wiredKeys = params
          .filter((p) => data.ports[p.key]?.binding?.kind === "node")
          .map((p) => p.key);
        return (
          <div key={grp.key} className="anim-group">
            <button
              className="anim-group-head"
              onClick={() => setOpen((o) => ({ ...o, [grp.key]: !o[grp.key] }))}
            >
              <span>{isOpen ? "▾" : "▸"}</span> {grp.label}
              {!isOpen && wiredKeys.length > 0 && (
                <span className="anim-group-wired">●{wiredKeys.length}</span>
              )}
            </button>
            {!isOpen && wiredKeys.length > 0 && (
              <GroupAnchor nodeId={node.id} portKeys={wiredKeys} portRef={helpers.portRef} />
            )}
            {isOpen &&
              params.map((p) => (
                <ParamRow
                  key={p.key}
                  node={node}
                  param={p}
                  helpers={helpers}
                  onGraphChange={onGraphChange}
                  onDetach={detach}
                />
              ))}
          </div>
        );
      })}
    </NodeFrame>
  );
}
