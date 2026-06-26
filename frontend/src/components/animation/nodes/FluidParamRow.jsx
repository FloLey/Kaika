import { useCallback } from "react";
import Ctl from "../../../ui/Ctl.jsx";
import { Port } from "./NodeFrame.jsx";
import { setConstValue, setNodeRange } from "./fluidBindings";

// One fluid param's input-port ROW and the collapsed-group anchor, extracted from
// FluidNode. A const-bound row shows a single-thumb Ctl (the value IS the field); a
// node-bound row swaps it for a two-thumb range slider (the lo/hi the 0..1 pulse
// maps into) plus a detach ✕.

// A dual-thumb range slider for a node-bound port: two overlaid native range inputs
// (only the thumbs take pointer events) clamped so lo <= hi. A readout shows the
// exact values; ✕ detaches the wire.
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
// anchored to the card's section instead of vanishing.
export function GroupAnchor({ nodeId, portKeys, portRef }) {
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

export function ParamRow({ node, param, helpers, onGraphChange, onDetach }) {
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
