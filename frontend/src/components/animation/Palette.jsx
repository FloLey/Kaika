import { useState } from "react";
import { signalNode, constantNode, fluidNode, outputNode } from "../../lib/graphModel.js";
import { stemColor } from "../../lib/segments.js";

// The floating palette (06 §Palette): buttons that add each node type near the
// canvas center (in graph space). + Signal opens a picker of the segment's
// signals. Fluid/Output are capped at one each (v1) and disabled once present.
//
// Props:
//   graph         — to detect existing fluid/output and place new nodes
//   signals       — the segment's signal list (for the + Signal picker)
//   centerGraph   — () => {x,y} graph-space point to drop new nodes at
//   onGraphChange(updater)
export default function Palette({ graph, signals = [], centerGraph, onGraphChange }) {
  const [picking, setPicking] = useState(false);

  const hasFluid = graph.nodes.some((n) => n.type === "fluid");
  const hasOutput = graph.nodes.some((n) => n.type === "output");

  const where = () => (centerGraph ? centerGraph() : { x: 80, y: 80 });

  const add = (factory) =>
    onGraphChange((g) => {
      const { x, y } = where();
      return { ...g, nodes: [...g.nodes, factory(x, y)] };
    });

  const addSignal = (signal) => {
    onGraphChange((g) => {
      const { x, y } = where();
      return { ...g, nodes: [...g.nodes, signalNode(signal, x, y)] };
    });
    setPicking(false);
  };

  return (
    <div className="anim-palette">
      <button className="btn sm" onClick={() => setPicking((p) => !p)}>+ Signal</button>
      <button className="btn sm" onClick={() => add((x, y) => constantNode(x, y))}>+ Constant</button>
      <button className="btn sm" disabled={hasFluid}
              onClick={() => add((x, y) => fluidNode(x, y))}>+ Fluid</button>
      <button className="btn sm" disabled={hasOutput}
              onClick={() => add((x, y) => outputNode(x, y))}>+ Output</button>

      {picking && (
        <div className="anim-signal-picker">
          {signals.length === 0 && <div className="anim-picker-empty">no signals in this segment</div>}
          {signals.map((s) => (
            <button
              key={s.id}
              className="anim-picker-item"
              style={{ "--accent": stemColor(s.stemKey) }}
              onClick={() => addSignal(s)}
            >
              <span className="anim-picker-dot" />
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
