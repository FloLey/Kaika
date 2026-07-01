import NodeFrame, { Port } from "./NodeFrame";
import CurveView from "../../studio/CurveView";
import PulsePad from "../../studio/PulsePad";
import { videoSource } from "../../../lib/graphModel";
import { useResolvedCurve } from "./useResolvedCurve";
import type { NodeProps } from "./nodeProps";

// A pure monitor (oscilloscope): mirrors the signal card's live sparkline + pulse pad
// for WHATEVER value feeds it (lfo / signal / noise / math / shaper), and passes that
// value straight through its output. The curve is resolved by the backend
// (`/resolve` -> graph executor), so it shows exactly what the node produces. One
// `value` in (left), one `value` out (right).
export default function ScopeNode({ node, selected, helpers, ctx, onDelete }: NodeProps) {
  const { graph, segment, groupClock, groupPlaying } = ctx || {};
  const segStart = segment?.start ?? 0;
  const segEnd = segment?.end ?? 0;
  const winLen = Math.max(0.001, segEnd - segStart);

  // The node wired into our `in` port (drives the chip label + the "wired?" check).
  const srcId = graph ? videoSource(graph, node.id, "in") : null;
  const srcNode = srcId && graph ? graph.nodes.find((n) => n.id === srcId) : null;

  // Resolve THIS node's passthrough curve from the backend (the same `/resolve` the
  // signal cards use) — shared with the generator cards via useResolvedCurve so the
  // fetch/debounce/error logic lives in one place. The depKey serializes the whole
  // contributing graph + window, since Scope monitors a value that depends on upstream.
  const depKey = graph ? JSON.stringify([graph.nodes, graph.edges, segment?.signals]) : "";
  const { curve, loading } = useResolvedCurve(ctx, node.id, depKey);

  const color = "var(--mod)";

  return (
    <NodeFrame
      node={node}
      title="scope"
      accent={color}
      selected={selected}
      onTitlePointerDown={helpers.onTitlePointerDown}
      onDelete={onDelete}
      sideIn={
        <Port
          kind="in"
          flow="value"
          nodeId={node.id}
          portId="in"
          portRef={helpers.portRef}
          title="value in"
        />
      }
      sideOut={
        <Port
          kind="out"
          flow="value"
          nodeId={node.id}
          portId="out"
          portRef={helpers.portRef}
          startConnect={helpers.startConnect}
          title="value out (passthrough)"
        />
      }
    >
      {srcId ? (
        <div className="anim-signal">
          <div className="anim-signal-meta">
            <span className="anim-scope-chip">{srcNode ? srcNode.type : "value"}</span>
            <span className="anim-signal-name">monitoring</span>
          </div>
          <div className="anim-signal-viz">
            <div className="anim-signal-spark">
              <CurveView
                curve={curve}
                color={color}
                loading={loading}
                audioRef={groupClock}
                segStart={segStart}
                winLen={winLen}
                playing={groupPlaying}
              />
            </div>
            <PulsePad
              audioRef={groupClock}
              curve={curve}
              segStart={segStart}
              winLen={winLen}
              color={color}
              playing={groupPlaying}
              idleLoop
            />
          </div>
        </div>
      ) : (
        <div className="anim-signal anim-signal-missing">
          <div className="anim-missing-msg">
            no input
            <span className="anim-missing-id">wire a signal in</span>
          </div>
          <div className="anim-missing-hint">
            connect an lfo / noise / signal / math to the left port to watch it.
          </div>
        </div>
      )}
    </NodeFrame>
  );
}
