import type { ChangeEvent } from "react";
import { chromeFor } from "./nodes/registry";
import { nodeParams } from "../../lib/nodeParams";
import { assignEdge, isLooseEdge, unassignEdge } from "../../lib/graphModel";
import type { Graph, GraphNode } from "../../lib/types";

interface PortConnectionsProps {
  node: GraphNode;
  graph: Graph;
  signals?: { id: string; name?: string }[];
  onGraphChange: (updater: (g: Graph) => Graph) => void;
}

// The settings window's wiring panel: one dropdown per modulatable input port.
// The "not connected" group on top lists sources whose wires are PARKED on this
// card (loose gray edges — dropped on the card body, no port yet); picking one
// assigns that wire to the port (a real binding — the gray line turns solid).
// Clearing an assigned port demotes its wire back to loose instead of deleting
// it, so re-routing a source between ports never loses the connection.
export default function PortConnections({ node, graph, signals, onGraphChange }: PortConnectionsProps) {
  const params = nodeParams(node.type);
  const loose = (graph.edges || []).filter((e) => e.target === node.id && isLooseEdge(e));
  if (!params.length || !(loose.length || params.length)) return null;

  const srcLabel = (srcId: string): string => {
    const src = graph.nodes.find((n) => n.id === srcId);
    if (!src) return srcId;
    if (src.type === "signal") {
      const sig = (signals || []).find((s) => s.id === src.data.signalId);
      return `signal · ${sig?.name || src.data.label || srcId}`;
    }
    return `${chromeFor(src.type).title} · ${srcId.slice(-4)}`;
  };

  // Current source per port (a {kind:"node"} binding), for the "connected" info row.
  const ports = (node.data as { ports?: Record<string, { binding?: { kind?: string; nodeId?: string } }> }).ports || {};
  const boundTo = (key: string): string | null => {
    const b = ports[key]?.binding;
    return b && b.kind === "node" && b.nodeId ? b.nodeId : null;
  };

  // Nothing to manage: no parked wires AND nothing wired — the ParamRows in the
  // card body already cover pristine const ports.
  if (!loose.length && !params.some((p) => boundTo(p.key))) return null;

  const onPick = (portKey: string) => (e: ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    if (v === "") {
      onGraphChange((g) => unassignEdge(g, node.id, portKey));
    } else {
      onGraphChange((g) => assignEdge(g, v, portKey));
    }
  };

  return (
    <div className="port-connections">
      <div className="port-connections-head">
        INPUTS
        {loose.length > 0 && (
          <span className="port-connections-loose">
            {loose.length} wire{loose.length === 1 ? "" : "s"} not connected
          </span>
        )}
      </div>
      {params.map((p) => {
        const bound = boundTo(p.key);
        return (
          <label className="port-connections-row" key={p.key}>
            <span className="port-connections-label">{p.label}</span>
            <select
              className="anim-select"
              value={bound ? "__bound" : ""}
              onChange={onPick(p.key)}
            >
              <option value="">{bound ? "— unwire (park the line) —" : "— not wired —"}</option>
              {loose.length > 0 && (
                <optgroup label="not connected">
                  {loose.map((e) => (
                    <option key={e.id} value={e.id}>
                      {srcLabel(e.source)}
                    </option>
                  ))}
                </optgroup>
              )}
              {bound && (
                <option value="__bound" disabled>
                  {srcLabel(bound)} (wired)
                </option>
              )}
            </select>
          </label>
        );
      })}
    </div>
  );
}
