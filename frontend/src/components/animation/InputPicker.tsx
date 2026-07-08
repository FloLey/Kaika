import type { ChangeEvent } from "react";
import { chromeFor } from "./nodes/registry";
import ArgInfo from "./nodes/ArgInfo";
import { ParamRow } from "./nodes/FluidParamRow";
import { isLooseEdge } from "../../lib/graphModel";
import {
  connect,
  connectVideo,
  disconnect,
  assignEdge,
  unassignEdge,
} from "../../lib/graph/mutations";
import { nodeParam } from "../../lib/nodeParams";
import { cardInputs, inputSource, partitionSources, type InputDesc } from "./nodeInputs";
import type { NodeHelpers } from "./nodes/nodeProps";
import type { Graph, GraphNode } from "../../lib/types";

interface Props {
  node: GraphNode;
  graph: Graph;
  signals?: { id: string; name?: string }[];
  onGraphChange: (updater: (g: Graph) => Graph) => void;
}

// The settings window has no wiring canvas, so a param's ParamRow port dot registers
// into the void (it's CSS-hidden); the value slider + source dropdown do the work.
const NOOP_HELPERS = {
  portRef: () => () => {},
  startConnect: () => {},
  onTitlePointerDown: () => {},
  onLayoutChange: () => {},
} as unknown as NodeHelpers;

// The settings window's INPUTS panel: the single, complete editor for every input on
// every card. A `param` row shows its VALUE control (const slider / [lo,hi] range via
// ParamRow) AND a source dropdown; an `edge` row shows a source dropdown; both carry a
// "?". Dynamic groups (math/merge inputs, combine layers) get + add / per-row ✕. This
// makes value + source editing mode-independent — the card body's own value sliders are
// hidden in the modal (see .node-settings CSS).
export default function InputPicker({ node, graph, signals, onGraphChange }: Props) {
  const { inputs, dynamic } = cardInputs(node);
  if (!inputs.length && !dynamic) return null;

  // A card's human name wins; else the type + id-suffix fallback (signals show their
  // segment-signal name).
  const srcLabel = (srcId: string): string => {
    const src = graph.nodes.find((n) => n.id === srcId);
    if (!src) return srcId;
    if (src.name) return src.name;
    if (src.type === "signal") {
      const sig = (signals || []).find((s) => s.id === (src.data as { signalId?: string }).signalId);
      return `signal · ${sig?.name || (src.data as { label?: string }).label || srcId}`;
    }
    return `${chromeFor(src.type).title} · ${srcId.slice(-4)}`;
  };

  const currentSource = (input: InputDesc): string | null => inputSource(node, graph, input);

  // Dropdown value encoding: a loose edge is "l:<edgeId>" (assign that parked wire onto
  // this port), any other value is a source node id (fresh wire), "" clears.
  const onPick = (input: InputDesc) => (e: ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    onGraphChange((g) => {
      // Clear → demote any real edge on this port back to a gray loose wire (kept
      // parked on the card so it can be re-routed), rather than deleting it outright.
      if (!v) return unassignEdge(g, node.id, input.portId);
      // A parked loose wire → promote it onto this exact port (restores the invariant).
      if (v.startsWith("l:")) return assignEdge(g, v.slice(2), input.portId);
      // A source node id → wire it, tidying any parked wire from that same source. For a
      // card with numbered dynamic inputs (math/merge/combine) this is a MOVE: strip the
      // source from any SIBLING numbered input too, so it never feeds two slots — lets you
      // swap operands / reorder layers by re-picking, without duplicating or rewiring.
      const g2 = {
        ...g,
        edges: g.edges.filter((ed) => {
          if (ed.source !== v || ed.target !== node.id) return true;
          if (isLooseEdge(ed)) return false; // consume the parked wire from this source
          if (dynamic && ed.targetPort !== input.portId) return false; // move off siblings
          return true;
        }),
      };
      return input.kind === "param"
        ? connect(g2, v, node.id, input.portId)
        : connectVideo(g2, v, "out", node.id, input.portId);
    });
  };

  return (
    <div className="port-connections">
      <div className="port-connections-head">INPUTS</div>
      {inputs.map((input) => {
        const cur = currentSource(input);
        // Three sections: parked-but-unassigned wires on this card (top), sources
        // already assigned to one of this card's inputs, then every other candidate.
        const { loose, assigned, other } = partitionSources(graph, node, input.flow);
        const known = new Set([...loose.map((l) => l.srcId), ...assigned, ...other]);
        const param = input.kind === "param" ? nodeParam(node.type, input.portId) : undefined;
        const dropdown = (
          <select className="anim-select" value={cur || ""} onChange={onPick(input)}>
            <option value="">— none —</option>
            {loose.length > 0 && (
              <optgroup label="connected — unassigned">
                {loose.map((l) => (
                  <option key={l.edgeId} value={`l:${l.edgeId}`}>
                    {srcLabel(l.srcId)}
                  </option>
                ))}
              </optgroup>
            )}
            {assigned.length > 0 && (
              <optgroup label="connected">
                {assigned.map((id) => (
                  <option key={id} value={id}>
                    {srcLabel(id)}
                  </option>
                ))}
              </optgroup>
            )}
            {other.length > 0 && (
              <optgroup label="other">
                {other.map((id) => (
                  <option key={id} value={id}>
                    {srcLabel(id)}
                  </option>
                ))}
              </optgroup>
            )}
            {/* Safety net: a current source not caught by the partition (shouldn't
                happen) still shows so the select never renders a blank selection. */}
            {cur && !known.has(cur) && <option value={cur}>{srcLabel(cur)}</option>}
          </select>
        );
        return (
          <div className="port-connections-row" key={input.portId}>
            {param ? (
              // ParamRow carries the label + "?" + the const slider / [lo,hi] range.
              <ParamRow
                node={node}
                param={param}
                helpers={NOOP_HELPERS}
                onGraphChange={onGraphChange}
                onDetach={(k) => onGraphChange((g) => disconnect(g, node.id, k))}
              />
            ) : (
              <>
                <span className="port-connections-label">{input.label}</span>
                <ArgInfo type={node.type} k={input.helpKey ?? input.portId} />
              </>
            )}
            {dropdown}
            {dynamic && (
              <button
                type="button"
                className="iconbtn"
                title="remove this input"
                onClick={() => onGraphChange((g) => dynamic.remove(g, node.id, input.portId))}
              >
                ✕
              </button>
            )}
          </div>
        );
      })}
      {dynamic && (
        <button
          type="button"
          className="btn sm"
          onClick={() => onGraphChange((g) => dynamic.add(g, node.id))}
        >
          + {dynamic.label}
        </button>
      )}
    </div>
  );
}
