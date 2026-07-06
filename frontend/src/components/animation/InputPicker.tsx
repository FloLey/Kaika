import type { ChangeEvent } from "react";
import { chromeFor } from "./nodes/registry";
import { videoSource, isLooseEdge } from "../../lib/graphModel";
import { connect, connectVideo, disconnect } from "../../lib/graph/mutations";
import { cardInputs, sourcesForFlow, type InputDesc } from "./nodeInputs";
import type { Graph, GraphNode } from "../../lib/types";

interface Props {
  node: GraphNode;
  graph: Graph;
  signals?: { id: string; name?: string }[];
  onGraphChange: (updater: (g: Graph) => Graph) => void;
}

// The settings window's INPUTS panel: one dropdown per input (every card, not just
// ported ones), listing the available signals/sources of the input's flow — so you can
// wire gate/math/shaper/… inputs without dragging on the canvas. Dynamic groups
// (math/merge inputs, combine layers) get + add / per-row ✕. Const/range editing for
// param ports stays in the card body's ParamRow.
export default function InputPicker({ node, graph, signals, onGraphChange }: Props) {
  const { inputs, dynamic } = cardInputs(node);
  if (!inputs.length && !dynamic) return null;

  const srcLabel = (srcId: string): string => {
    const src = graph.nodes.find((n) => n.id === srcId);
    if (!src) return srcId;
    if (src.type === "signal") {
      const sig = (signals || []).find((s) => s.id === (src.data as { signalId?: string }).signalId);
      return `signal · ${sig?.name || (src.data as { label?: string }).label || srcId}`;
    }
    return `${chromeFor(src.type).title} · ${srcId.slice(-4)}`;
  };

  const currentSource = (input: InputDesc): string | null => {
    if (input.kind === "param") {
      const ports =
        (node.data as { ports?: Record<string, { binding?: { kind?: string; nodeId?: string } }> })
          .ports || {};
      const b = ports[input.portId]?.binding;
      return b && b.kind === "node" && b.nodeId ? b.nodeId : null;
    }
    return videoSource(graph, node.id, input.portId);
  };

  const onPick = (input: InputDesc) => (e: ChangeEvent<HTMLSelectElement>) => {
    const srcId = e.target.value;
    onGraphChange((g) => {
      // Clear
      if (!srcId) {
        return input.kind === "param"
          ? disconnect(g, node.id, input.portId)
          : {
              ...g,
              edges: g.edges.filter((ed) => !(ed.target === node.id && ed.targetPort === input.portId)),
            };
      }
      // Wire — and tidy any parked (loose) wire from the same source onto this card.
      const g2 = {
        ...g,
        edges: g.edges.filter((ed) => !(ed.source === srcId && ed.target === node.id && isLooseEdge(ed))),
      };
      return input.kind === "param"
        ? connect(g2, srcId, node.id, input.portId)
        : connectVideo(g2, srcId, "out", node.id, input.portId);
    });
  };

  return (
    <div className="port-connections">
      <div className="port-connections-head">INPUTS</div>
      {inputs.map((input) => {
        const cur = currentSource(input);
        const opts = sourcesForFlow(graph, input.flow, node.id);
        return (
          <label className="port-connections-row" key={input.portId}>
            <span className="port-connections-label">{input.label}</span>
            <select className="anim-select" value={cur || ""} onChange={onPick(input)}>
              <option value="">— none —</option>
              {opts.map((s) => (
                <option key={s.id} value={s.id}>
                  {srcLabel(s.id)}
                </option>
              ))}
              {cur && !opts.some((s) => s.id === cur) && (
                <option value={cur}>{srcLabel(cur)}</option>
              )}
            </select>
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
          </label>
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
