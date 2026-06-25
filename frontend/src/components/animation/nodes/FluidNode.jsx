import { useEffect, useMemo, useState } from "react";
import { Toggle } from "../../../ui/Ctl.jsx";
import NodeFrame, { Port } from "./NodeFrame.jsx";
import { FLUID_PARAMS } from "../../../lib/fluidParams.js";
import { videoSource } from "../../../lib/graphModel";
import { patchStatic } from "./fluidBindings.js";
import { ParamRow, GroupAnchor } from "./FluidParamRow.jsx";

// The artifact card (06 §FluidNode). Static controls on top; one input-port ROW
// per FLUID_PARAMS entry, grouped source/color/medium (rows + the collapsed-group
// anchor live in FluidParamRow.jsx). One `out` video port (→ OutputNode). Groups
// collapse to stay tidy.
//
// PATH: v1 uses a SIMPLIFIED static path — a single center point plus the radial
// toggle (per 06's recommendation). The full FluidLab path editor is deferred.

const GROUPS = [
  { key: "source", label: "SOURCE" },
  { key: "color", label: "COLOR" },
  { key: "medium", label: "MEDIUM" },
];

export default function FluidNode({ node, selected, helpers, ctx, onGraphChange, onDetach, onDelete }) {
  const [open, setOpen] = useState({ source: true, color: true, medium: false });
  const s = node.data.static;

  // A wired points card overrides the single-centre source with N source positions.
  // Memoized so this graph walk doesn't re-run on every unrelated re-render.
  const posCount = useMemo(() => {
    const srcId = ctx?.graph ? videoSource(ctx.graph, node.id, "positions") : null;
    const pn = srcId ? ctx.graph.nodes.find((n) => n.id === srcId) : null;
    return pn && pn.type === "points" ? (pn.data.points || []).length : 0;
  }, [ctx?.graph, node.id]);

  // Collapsing/expanding a group mounts/unmounts ports; ask the canvas to redraw
  // edges so wires re-anchor (to the group header when collapsed, to the row port
  // when open). `onLayoutChange` is stable, so this only fires when `open` flips.
  const { onLayoutChange } = helpers;
  useEffect(() => { onLayoutChange?.(); }, [open, onLayoutChange]);

  const setStatic = (patch) => onGraphChange(patchStatic(node.id, patch));

  const detach = (key) => onDetach(node.id, key);

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

      {/* Static controls (non-port params). The clip always spans the full segment,
          so there is no duration control. */}
      <div className="anim-static">
        <Toggle label="enabled" value={s.enabled} onChange={(v) => setStatic({ enabled: v })} />
        <Toggle label="radial" value={s.radial} onChange={(v) => setStatic({ radial: v })} />
        <Toggle
          label="wrap edges"
          value={s.wrap !== false}
          help="On: fluid that leaves one edge re-enters the opposite (a looping torus). Off: fluid that leaves the frame is gone for good."
          onChange={(v) => setStatic({ wrap: v })}
        />
        {(s.radial || s.wrap === false) && (
          <div className="anim-path-note">
            {s.radial ? "radial" : ""}{s.radial && s.wrap === false ? " · " : ""}
            {s.wrap === false ? "open edges" : ""}
          </div>
        )}
      </div>

      {/* Param input ports, grouped + collapsible. */}
      {GROUPS.map((grp) => {
        const params = FLUID_PARAMS.filter((p) => p.group === grp.key);
        const isOpen = open[grp.key];
        const wiredKeys = params
          .filter((p) => node.data.ports[p.key]?.binding?.kind === "node")
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
            {isOpen && params.map((p) => (
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
