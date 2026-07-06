import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { signalNode } from "../../lib/graphModel";
import { paletteMenu } from "./nodes/registry";
import { stemColor } from "../../lib/segments";
import type { Graph, GraphNode } from "../../lib/types";
import type { SignalDef } from "./nodes/nodeProps";

// The add-node toolbar: a bar across the top of the animation panel. One button PER
// category (Sources / Modulators / Generators / Compositing / Output, in data-flow
// order); each opens a small dropdown of that category's node types. Picking one adds
// it at the canvas center. The Signal entry has no factory — it opens the segment's
// signal picker instead. ⚙ output opens the project render settings.
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
  // Which category dropdown is open (one at a time), and whether the signal picker
  // (opened from the Sources menu's factory-less Signal entry) is showing.
  const [openCat, setOpenCat] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const clusterRef = useRef<HTMLDivElement>(null);

  // Close any open category menu / signal picker when clicking outside the add cluster.
  useEffect(() => {
    if (!openCat && !picking) return;
    const onDocPointerDown = (e: PointerEvent) => {
      if (clusterRef.current && !clusterRef.current.contains(e.target as Node)) {
        setOpenCat(null);
        setPicking(false);
      }
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, [openCat, picking]);

  const where = () => (centerGraph ? centerGraph() : { x: 80, y: 80 });

  const add = (factory: (x: number, y: number) => GraphNode) =>
    onGraphChange((g) => {
      const { x, y } = where();
      return { ...g, nodes: [...g.nodes, factory(x, y)] };
    });

  const addSignal = (signal: SignalDef) => {
    onGraphChange((g) => {
      const { x, y } = where();
      return { ...g, nodes: [...g.nodes, signalNode(signal, x, y)] };
    });
    setPicking(false);
    setOpenCat(null);
  };

  // A menu entry: factory entries add their node + close the menu; the factory-less
  // `signal` entry opens the segment-signal picker instead.
  const onPick = (factory?: (x: number, y: number) => GraphNode) => {
    if (factory) {
      add(factory);
      setOpenCat(null);
    } else {
      setPicking(true);
      setOpenCat(null);
    }
  };

  return (
    <div className="anim-toolbar">
      <div className="anim-add-cluster" ref={clusterRef}>
        {paletteMenu().map((group) => (
          <div className="anim-add-menu" key={group.category}>
            <button
              className={"btn sm anim-add-btn" + (openCat === group.category ? " on" : "")}
              aria-haspopup="menu"
              aria-expanded={openCat === group.category}
              onClick={() => {
                setPicking(false);
                setOpenCat((c) => (c === group.category ? null : group.category));
              }}
            >
              {group.label}
            </button>
            {openCat === group.category && (
              <div className="anim-add-dropdown" role="menu">
                {group.specs.map((spec) => {
                  const p = spec.palette!;
                  const io = p.io;
                  return (
                    <button
                      key={spec.type}
                      role="menuitem"
                      className="anim-add-item"
                      title={p.title}
                      onClick={() => onPick(spec.factory)}
                    >
                      {p.label}
                      {/* Hover help: what it does + how, and the input → output flow. */}
                      <span className="anim-add-tip" role="tooltip">
                        <span className="anim-add-tip-help">{p.help ?? p.title}</span>
                        {io && (
                          <span className="anim-add-tip-io">
                            {io.in ? `${io.in} → ${io.out}` : `→ ${io.out}`}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            {group.category === "sources" && picking && (
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
        ))}
      </div>

      <span className="anim-toolbar-spacer" />

      {onToggleMinimizeAll && (
        <button
          className="btn sm"
          title={
            allMinimized
              ? "Expand every card to its full on-canvas view"
              : "Collapse every card back to its compact view"
          }
          onClick={onToggleMinimizeAll}
        >
          {allMinimized ? "▢ expand all" : "– collapse all"}
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
