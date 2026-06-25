import { useCallback, useEffect, useMemo, useState } from "react";
import Ctl, { Toggle } from "../../../ui/Ctl.jsx";
import NodeFrame, { Port } from "./NodeFrame.jsx";
import { FLUID_PARAMS } from "../../../lib/fluidParams.js";
import { videoSource } from "../../../lib/graphModel.js";
import { setConstValue, setNodeRange, patchStatic } from "./fluidBindings.js";

// The artifact card (06 §FluidNode). Static controls on top; one input-port ROW
// per FLUID_PARAMS entry, grouped source/color/medium. A const-bound row shows an
// inline single-thumb Ctl (the value IS the field); a node-bound row swaps it for
// a TWO-thumb range slider — the bullets set the lo/hi the pulse maps into — plus
// a detach ✕. One `out` video port (→ OutputNode). Groups collapse to stay tidy.
//
// PATH: v1 uses a SIMPLIFIED static path — a single center point plus the radial
// toggle (per 06's recommendation). The full FluidLab path editor is deferred.

const GROUPS = [
  { key: "source", label: "SOURCE" },
  { key: "color", label: "COLOR" },
  { key: "medium", label: "MEDIUM" },
];

// A dual-thumb range slider for a node-bound port: the same track as the const
// slider, but two bullets defining the lo/hi the 0..1 pulse maps into (native
// units; defaults to the param's full min..max on connect). Two overlaid native
// range inputs — only the thumbs take pointer events — clamp against each other so
// lo <= hi. A small readout shows the exact values; ✕ detaches the wire.
function RangeControl({ param, binding, onRange, onDetach }) {
  const fmt = param.fmt || ((v) => `${v}`);
  const span = param.max - param.min || 1;
  const pct = (v) => `${(((v - param.min) / span) * 100).toFixed(2)}%`;
  return (
    <div className="anim-range">
      <div className="dual-slider">
        <div
          className="dual-fill"
          style={{ left: pct(binding.lo), right: `calc(100% - ${pct(binding.hi)})` }}
        />
        <input
          type="range" className="dual-thumb" title="lo"
          min={param.min} max={param.max} step={param.step} value={binding.lo}
          onChange={(e) => onRange(Math.min(parseFloat(e.target.value), binding.hi), binding.hi)}
        />
        <input
          type="range" className="dual-thumb" title="hi"
          min={param.min} max={param.max} step={param.step} value={binding.hi}
          onChange={(e) => onRange(binding.lo, Math.max(parseFloat(e.target.value), binding.lo))}
        />
      </div>
      <span className="anim-range-fmt">{fmt(binding.lo)}–{fmt(binding.hi)}</span>
      <button className="iconbtn sm anim-detach" title="detach" onClick={onDetach}>✕</button>
    </div>
  );
}

// When a group is collapsed its param rows (and their input ports) unmount, which
// would drop any wires into them. This single dot on the collapsed group header
// re-registers every wired param key in that group to itself, so the wires stay —
// anchored to the card's section instead of vanishing. All wires into the group
// converge on this one dot.
function GroupAnchor({ nodeId, portKeys, portRef }) {
  const keyStr = portKeys.join(",");
  const ref = useCallback(
    (el) => { for (const k of portKeys) portRef(nodeId, k, "in", "value")(el); },
    // Deliberate: key on the serialized `keyStr`, not the `portKeys` array identity,
    // so the ref callback stays stable while the port set is unchanged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodeId, keyStr, portRef]
  );
  return (
    <span
      className="gc-port gc-port-in gc-port-value anim-group-anchor"
      ref={ref}
      title={`${portKeys.length} wired param${portKeys.length > 1 ? "s" : ""} (collapsed)`}
    />
  );
}

function ParamRow({ node, param, helpers, onGraphChange, onDetach }) {
  const port = node.data.ports[param.key];
  const binding = port?.binding || { kind: "const", value: param.def };

  const setConst = (v) => onGraphChange(setConstValue(node.id, param.key, v));
  const setRange = (lo, hi) => onGraphChange(setNodeRange(node.id, param.key, lo, hi));

  return (
    <div className="anim-param-row">
      <Port
        kind="in"
        flow="value"
        nodeId={node.id}
        portId={param.key}
        portRef={helpers.portRef}
        title={`${param.label} in`}
      />
      <span className="anim-param-label">{param.label}</span>
      {binding.kind === "node" ? (
        <RangeControl
          param={param}
          binding={binding}
          onRange={setRange}
          onDetach={() => onDetach(param.key)}
        />
      ) : (
        <Ctl
          label=""
          value={binding.value}
          min={param.min}
          max={param.max}
          step={param.step}
          fmt={param.fmt}
          onChange={setConst}
        />
      )}
    </div>
  );
}

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

  // The swatch reflects the r/g/b ports (now modulatable, in the COLOR group): a
  // const channel shows its value; a wired channel shows its range midpoint as a
  // hint (its real value pulses with the signal at render time).
  const chanVal = (k) => {
    const b = node.data.ports[k]?.binding || {};
    return b.kind === "node" ? (b.lo + b.hi) / 2 : (b.value ?? 0);
  };
  const swatchRgb = ["r", "g", "b"].map((k) => Math.round(chanVal(k) * 255)).join(",");

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
        <div className="anim-color">
          <span className="ctl-label">color</span>
          <div className="color-swatch" style={{ background: `rgb(${swatchRgb})` }} />
        </div>
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
