import { useState } from "react";
import { signalNode, fluidNode, outputNode, combineNode, pointsNode, mkEdgeId } from "../../lib/graphModel";
import { stemColor } from "../../lib/segments.js";

// The add-node toolbar: a bar across the top of the animation panel (not floating
// on the canvas). Buttons add each node type at the canvas center; + Signal opens
// a picker of the segment's signals; ⚙ output opens the project render settings.
// Multiple fluid/output nodes are allowed — a graph can hold N independent
// fluid -> output pipelines. + Pipeline adds a fluid + output already wired.
//
// Props:
//   signals       — the segment's signal list (for the + Signal picker)
//   centerGraph   — () => {x,y} graph-space point to drop new nodes at
//   onOpenOutput  — open the output-settings modal (optional)
//   onGraphChange(updater)
export default function Palette({
  signals = [], centerGraph, onOpenOutput,
  isFullscreen, onToggleFullscreen, onGraphChange,
  allMinimized, onToggleMinimizeAll,
}) {
  const [picking, setPicking] = useState(false);

  const where = () => (centerGraph ? centerGraph() : { x: 80, y: 80 });

  const add = (factory) =>
    onGraphChange((g) => {
      const { x, y } = where();
      return { ...g, nodes: [...g.nodes, factory(x, y)] };
    });

  // A fluid + output, side by side and pre-wired — one click to a new pipeline.
  const addPipeline = () =>
    onGraphChange((g) => {
      const { x, y } = where();
      const fluid = fluidNode(x, y);
      const output = outputNode(x + 330, y);
      const edge = { id: mkEdgeId(), source: fluid.id, sourcePort: "out",
                     target: output.id, targetPort: "video" };
      return { ...g, nodes: [...g.nodes, fluid, output], edges: [...g.edges, edge] };
    });

  const addSignal = (signal) => {
    onGraphChange((g) => {
      const { x, y } = where();
      return { ...g, nodes: [...g.nodes, signalNode(signal, x, y)] };
    });
    setPicking(false);
  };

  return (
    <div className="anim-toolbar">
      <div className="anim-add-signal">
        <button className="btn sm" onClick={() => setPicking((p) => !p)}>+ Signal</button>
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
      <button className="btn sm" onClick={() => add((x, y) => fluidNode(x, y))}>+ Fluid</button>
      <button className="btn sm" title="Draw source points to feed a fluid's positions"
              onClick={() => add((x, y) => pointsNode(x, y))}>+ Points</button>
      <button className="btn sm" title="Combine fluids — merge (interact) or layered (stack)"
              onClick={() => add((x, y) => combineNode(x, y))}>+ Combine</button>
      <button className="btn sm" onClick={() => add((x, y) => outputNode(x, y))}>+ Output</button>
      <button className="btn sm" title="Add a fluid + output, pre-wired"
              onClick={addPipeline}>+ Pipeline</button>

      <span className="anim-toolbar-spacer" />

      {onToggleMinimizeAll && (
        <button
          className="btn sm"
          title={allMinimized ? "Expand all cards" : "Minimize all cards to their header"}
          onClick={onToggleMinimizeAll}
        >
          {allMinimized ? "▢ expand all" : "– minimize all"}
        </button>
      )}
      {onOpenOutput && (
        <button
          className="btn sm output-gear"
          title="Output settings (size, quality, fps, background)"
          onClick={onOpenOutput}
        >
          ⚙ output
        </button>
      )}
      {onToggleFullscreen && (
        <button
          className="btn sm"
          title={isFullscreen ? "Exit fullscreen" : "Fullscreen playground"}
          aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen playground"}
          onClick={onToggleFullscreen}
        >
          {isFullscreen ? "🗗 exit" : "⛶ fullscreen"}
        </button>
      )}
    </div>
  );
}
