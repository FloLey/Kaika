import CurveView from "../../studio/CurveView";
import PulsePad from "../../studio/PulsePad";
import { upstreamKey } from "../../../lib/graphModel";
import { useResolvedCurve } from "./useResolvedCurve";
import type { NodeCtx } from "./nodeProps";
import type { GraphNode } from "../../../lib/types";

interface Props {
  node: GraphNode;
  ctx?: NodeCtx;
  color?: string;
  compact?: boolean; // compact = the pulse pad alone; detailed = curve + pad
}

// The shared OUTPUT preview for any value card (signal/lfo/noise/shaper/gate/math/scope):
// its REAL resolved 0..1 curve (via /resolve, so it matches the render) shown as a
// pulsing pad (compact) or a curve + pulsing pad (detailed). Cards that need an input to
// produce a signal (shaper/gate/math) read flat until one is wired.
export default function ValuePreview({ node, ctx, color = "var(--mod)", compact = false }: Props) {
  const { graph, segment, groupClock, groupPlaying } = ctx || {};
  const segStart = segment?.start ?? 0;
  const segEnd = segment?.end ?? 0;
  const winLen = Math.max(0.001, segEnd - segStart);
  // The contributing-subgraph signature (value output depends on upstream only).
  const depKey = graph ? upstreamKey(graph, node.id, segment?.signals) : "";
  const { curve, loading } = useResolvedCurve(ctx, node.id, depKey);

  const pad = (
    <PulsePad
      audioRef={groupClock}
      curve={curve}
      segStart={segStart}
      winLen={winLen}
      color={color}
      playing={groupPlaying}
      idleLoop
    />
  );
  if (compact) return pad;
  return (
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
      {pad}
    </div>
  );
}
