import { useState } from "react";
import type { CSSProperties } from "react";
import { signalNode, fluidNode, outputNode, mkEdgeId } from "../../lib/graphModel";
import { paletteSpecs } from "./nodes/registry";
import { stemColor } from "../../lib/segments";
import type { Graph, GraphNode } from "../../lib/types";
import type { SignalDef } from "./nodes/nodeProps";

// The add-node toolbar: a bar across the top of the animation panel. Buttons add each
// node type at the canvas center; + Signal opens a picker of the segment's signals;
// ⚙ output opens the project render settings. + Pipeline adds a fluid + output wired.
interface PaletteProps {
  signals?: SignalDef[];
  centerGraph?: () => { x: number; y: number };
  onOpenOutput?: () => void;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  onGraphChange: (updater: (g: Graph) => Graph) => void;
  allMinimized?: boolean;
  onToggleMinimizeAll?: (() => void) | null;
}

export default function Palette({
  signals = [],
  centerGraph,
  onOpenOutput,
  isFullscreen,
  onToggleFullscreen,
  onGraphChange,
  allMinimized,
  onToggleMinimizeAll,
}: PaletteProps) {
  const [picking, setPicking] = useState(false);

  const where = () => (centerGraph ? centerGraph() : { x: 80, y: 80 });

  const add = (factory: (x: number, y: number) => GraphNode) =>
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
      const edge = {
        id: mkEdgeId(),
        source: fluid.id,
        sourcePort: "out",
        target: output.id,
        targetPort: "video",
      };
      return { ...g, nodes: [...g.nodes, fluid, output], edges: [...g.edges, edge] };
    });

  const addSignal = (signal: SignalDef) => {
    onGraphChange((g) => {
      const { x, y } = where();
      return { ...g, nodes: [...g.nodes, signalNode(signal, x, y)] };
    });
    setPicking(false);
  };

  return (
    <div className="anim-toolbar">
      <div className="anim-add-signal">
        <button className="btn sm" onClick={() => setPicking((p) => !p)}>
          + Signal
        </button>
        {picking && (
          <div className="anim-signal-picker">
            {signals.length === 0 && (
              <div className="anim-picker-empty">no signals in this segment</div>
            )}
            {signals.map((s) => (
              <button
                key={s.id}
                className="anim-picker-item"
                style={{ "--accent": stemColor(s.stemKey) } as CSSProperties}
                onClick={() => addSignal(s)}
              >
                <span className="anim-picker-dot" />
                {s.name}
              </button>
            ))}
          </div>
        )}
      </div>
      {paletteSpecs().map((spec) => (
        <button
          key={spec.type}
          className="btn sm"
          title={spec.palette!.title}
          onClick={() => add(spec.factory!)}
        >
          {spec.palette!.label}
        </button>
      ))}
      <button className="btn sm" title="Add a fluid + output, pre-wired" onClick={addPipeline}>
        + Pipeline
      </button>

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
