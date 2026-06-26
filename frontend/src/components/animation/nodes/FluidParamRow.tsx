import { useCallback } from "react";
import type { ChangeEvent, ComponentType } from "react";
import CtlJsx from "../../../ui/Ctl.jsx";
import { Port } from "./NodeFrame";
import { setConstValue, setNodeRange } from "./fluidBindings";
import type { NodeHelpers, PortRef } from "./nodeProps";
import type { Binding, FluidData, FluidParam, Graph, GraphNode } from "../../../lib/types";

// Bridge: ui/Ctl is still .jsx — cast until it converts (optional sweep).
const Ctl = CtlJsx as ComponentType<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// One fluid param's input-port ROW and the collapsed-group anchor, extracted from
// FluidNode. A const-bound row shows a single-thumb Ctl (the value IS the field); a
// node-bound row swaps it for a two-thumb range slider (the lo/hi the 0..1 pulse
// maps into) plus a detach ✕.

interface RangeControlProps {
  param: FluidParam;
  binding: { lo: number; hi: number };
  onRange: (lo: number, hi: number) => void;
  onDetach: () => void;
}

// A dual-thumb range slider for a node-bound port: two overlaid native range inputs
// (only the thumbs take pointer events) clamped so lo <= hi. A readout shows the
// exact values; ✕ detaches the wire.
function RangeControl({ param, binding, onRange, onDetach }: RangeControlProps) {
  const fmt = param.fmt || ((v: number) => `${v}`);
  const span = param.max - param.min || 1;
  const pct = (v: number) => `${(((v - param.min) / span) * 100).toFixed(2)}%`;
  return (
    <div className="anim-range">
      <div className="dual-slider">
        <div
          className="dual-fill"
          style={{ left: pct(binding.lo), right: `calc(100% - ${pct(binding.hi)})` }}
        />
        <input
          type="range"
          className="dual-thumb"
          title="lo"
          min={param.min}
          max={param.max}
          step={param.step}
          value={binding.lo}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            onRange(Math.min(parseFloat(e.target.value), binding.hi), binding.hi)
          }
        />
        <input
          type="range"
          className="dual-thumb"
          title="hi"
          min={param.min}
          max={param.max}
          step={param.step}
          value={binding.hi}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            onRange(binding.lo, Math.max(parseFloat(e.target.value), binding.lo))
          }
        />
      </div>
      <span className="anim-range-fmt">
        {fmt(binding.lo)}–{fmt(binding.hi)}
      </span>
      <button className="iconbtn sm anim-detach" title="detach" onClick={onDetach}>
        ✕
      </button>
    </div>
  );
}

interface GroupAnchorProps {
  nodeId: string;
  portKeys: string[];
  portRef: PortRef;
}

// When a group is collapsed its param rows (and their input ports) unmount, which
// would drop any wires into them. This single dot on the collapsed group header
// re-registers every wired param key in that group to itself, so the wires stay —
// anchored to the card's section instead of vanishing.
export function GroupAnchor({ nodeId, portKeys, portRef }: GroupAnchorProps) {
  const keyStr = portKeys.join(",");
  const ref = useCallback(
    (el: Element | null) => {
      for (const k of portKeys) portRef(nodeId, k, "in", "value")(el);
    },
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

interface ParamRowProps {
  node: GraphNode;
  param: FluidParam;
  helpers: NodeHelpers;
  onGraphChange: (updater: (g: Graph) => Graph) => void;
  onDetach: (key: string) => void;
}

export function ParamRow({ node, param, helpers, onGraphChange, onDetach }: ParamRowProps) {
  const data = node.data as FluidData;
  const port = data.ports[param.key];
  const binding: Binding = port?.binding || { kind: "const", value: param.def };

  const setConst = (v: number) => onGraphChange(setConstValue(node.id, param.key, v));
  const setRange = (lo: number, hi: number) =>
    onGraphChange(setNodeRange(node.id, param.key, lo, hi));

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
