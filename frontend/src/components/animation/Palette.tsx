import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { signalNode } from "../../lib/graphModel";
import type { GraphProblem } from "../../lib/graphModel";
import { paletteMenu } from "./nodes/registry";
import { defaultCardName } from "./nodeInputs";
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
  viewMode?: "detailed" | "compact";
  onSetViewMode?: ((mode: "detailed" | "compact") => void) | null;
  // ✨ arrange the current view's cards (null with fewer than two cards): detailed
  // spreads overlapping cards apart, compact packs them closer.
  onReorganize?: (() => void) | null;
  // Fit the view to every card (null while the graph is empty).
  onFitView?: (() => void) | null;
  // Dead-wiring warnings (lib/graph/problems) + the click-through that selects and
  // centers the offending card.
  problems?: GraphProblem[];
  onProblemClick?: (nodeId: string) => void;
  // Graph undo/redo (also bound to ⌘Z / ⇧⌘Z) — the buttons make it discoverable and
  // show whether there's anything to step through.
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
}

// One open category's item list. Measures itself on mount: when the right-anchored
// per-item help tip (240px + gap) would cross the panel's right edge — where
// .anim-wrap's overflow:hidden clips it — the `tip-left` class flips it to the left.
function CategoryDropdown({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [tipLeft, setTipLeft] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const wrap = el.closest(".anim-wrap");
    const bound = wrap ? wrap.getBoundingClientRect().right : window.innerWidth;
    setTipLeft(el.getBoundingClientRect().right + 250 > bound);
  }, []);
  return (
    <div ref={ref} className={"anim-add-dropdown" + (tipLeft ? " tip-left" : "")} role="menu">
      {children}
    </div>
  );
}

export default function Palette({
  signals = [],
  centerGraph,
  onOpenOutput,
  isFullscreen,
  onToggleFullscreen,
  onGraphChange,
  viewMode,
  onSetViewMode,
  onReorganize,
  onFitView,
  problems = [],
  onProblemClick,
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
}: PaletteProps) {
  // Which category dropdown is open (one at a time), and whether the signal picker
  // (opened from the Sources menu's factory-less Signal entry) is showing.
  const [openCat, setOpenCat] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const clusterRef = useRef<HTMLDivElement>(null);
  const problemsRef = useRef<HTMLDivElement>(null);

  // Close the problems dropdown on an outside click (same pattern as the add cluster).
  useEffect(() => {
    if (!problemsOpen) return undefined;
    const onDoc = (e: PointerEvent) => {
      if (problemsRef.current && !problemsRef.current.contains(e.target as Node)) {
        setProblemsOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDoc);
    return () => document.removeEventListener("pointerdown", onDoc);
  }, [problemsOpen]);

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

  // Every added card gets a default "<type> N" name (defaultCardName). Signals keep
  // their signal-derived name (already meaningful in dropdowns), so addSignal skips it.
  const add = (factory: (x: number, y: number) => GraphNode) =>
    onGraphChange((g) => {
      const { x, y } = where();
      const node = factory(x, y);
      return { ...g, nodes: [...g.nodes, { ...node, name: defaultCardName(g, node.type) }] };
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
              <CategoryDropdown>
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
              </CategoryDropdown>
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

      {problems.length > 0 && (
        // Dead-wiring warnings: things the render happily produces WRONG (flat-0
        // modulators, flattened ranges, unwired outputs) with no error anywhere.
        <div className="anim-problems" ref={problemsRef}>
          <button
            className={"btn sm anim-problems-btn" + (problemsOpen ? " on" : "")}
            aria-haspopup="menu"
            aria-expanded={problemsOpen}
            title="Wiring problems — these render silently wrong (click a row to jump to the card)"
            onClick={() => setProblemsOpen((v) => !v)}
          >
            ⚠ {problems.length} problem{problems.length === 1 ? "" : "s"}
          </button>
          {problemsOpen && (
            <div className="anim-problems-list" role="menu">
              {problems.map((p, i) => (
                <button
                  key={`${p.nodeId}-${i}`}
                  role="menuitem"
                  className="anim-problems-item"
                  onClick={() => {
                    onProblemClick?.(p.nodeId);
                    setProblemsOpen(false);
                  }}
                >
                  {p.message}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {(onUndo || onRedo) && (
        // Undo/redo was keyboard-only (⌘Z) and undiscoverable; the disabled state also
        // tells you when a step is available. Session-only, per segment.
        <div className="anim-history-btns">
          <button
            className="btn sm anim-history-btn"
            title="Undo (⌘Z)"
            aria-label="Undo"
            disabled={!canUndo}
            onClick={onUndo}
          >
            {/* U+FE0E forces TEXT presentation — macOS renders a bare ↩ as a blue emoji */}
            {"↩︎"}
          </button>
          <button
            className="btn sm anim-history-btn"
            title="Redo (⇧⌘Z)"
            aria-label="Redo"
            disabled={!canRedo}
            onClick={onRedo}
          >
            {"↪︎"}
          </button>
        </div>
      )}
      {onFitView && (
        <button
          className="btn sm"
          title="Fit view — pan/zoom so every card is visible (double-click empty canvas does the same)"
          onClick={onFitView}
        >
          ⊙ fit
        </button>
      )}
      {onReorganize && (
        // Per-view layout cleanup: each view keeps its OWN card positions, and this
        // lays out the one you're looking at along the data flow, untangling wires.
        <button
          className="btn sm"
          title={
            viewMode === "compact"
              ? "Arrange — lay the cards out along the data flow with the wires untangled (compact keeps them close)"
              : "Arrange — lay the cards out along the data flow, roomy and with the wires untangled"
          }
          onClick={onReorganize}
        >
          ✨ arrange
        </button>
      )}
      {onSetViewMode && (
        // The canvas view-mode switch: detailed (classic full cards) vs compact
        // (name + preview). Flipping clears the per-card ▢/– overrides — a clean
        // flip; you can still override individual cards inside either mode.
        <div className="anim-viewmode" role="group" aria-label="card view mode">
          <button
            className={"btn sm" + (viewMode !== "compact" ? " on" : "")}
            title="Detailed view — every card shows its full controls on the canvas"
            onClick={() => onSetViewMode("detailed")}
          >
            ▦ detailed
          </button>
          <button
            className={"btn sm" + (viewMode === "compact" ? " on" : "")}
            title="Compact view — name + live preview; click a card's body for its settings"
            onClick={() => onSetViewMode("compact")}
          >
            ▤ compact
          </button>
        </div>
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
