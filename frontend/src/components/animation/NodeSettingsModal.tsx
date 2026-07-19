import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { portalTarget } from "../../lib/portalTarget";
import { NODE_TYPES, chromeFor } from "./nodes/registry";
import { renameNode } from "../../lib/graphModel";
import { stemColor } from "../../lib/segments";
import InputPicker from "./InputPicker";
import SettingsVisual from "./nodes/SettingsVisual";
import LyricsLinesEditor, { type LyricLine } from "./LyricsLinesEditor";
import { MinimizeContext } from "./nodes/minimizeContext";
import type { NodeCtx, NodeHelpers } from "./nodes/nodeProps";
import type { Graph, GraphNode } from "../../lib/types";

// The per-card settings window a CompactCard opens: the node's FULL card component,
// rendered in a modal instead of on the canvas. Same portal + scrim pattern as
// AssetLibrary (portal to <body> so the fixed scrim isn't clipped by the pan/zoomed
// canvas; Escape or a scrim click closes; clicks inside don't bubble out). The card
// edits the graph through the same onGraphChange/onDetach as on-canvas, and `node`
// is passed straight through from CompactCard — it updates on every graph commit, so
// the modal always shows the LIVE node (never a stale snapshot).
//
// LAYOUT: a header (name + close) over two columns — the INPUTS panel + the card's
// controls on the LEFT, one big live preview on the RIGHT. The card's own inline
// preview suppresses itself (ctx.previewInPanel) so the right-column CompactPreview is
// the single visual (no double image, no duplicate fluid/combine stream).

// Canvas helpers stubbed out: the modal has no wiring canvas, so ports register into
// the void (their dots are hidden via .node-settings CSS), drags from an out port do
// nothing, the title bar doesn't drag, and there's no edge layout to re-anchor.
const STUB_HELPERS: NodeHelpers = {
  portRef: () => () => {},
  startConnect: () => {},
  onTitlePointerDown: () => {},
  onLayoutChange: () => {},
};

// Cards whose visual IS their editor (the points pad) render single-column — no
// separate preview panel would add anything.
const SINGLE_COLUMN = new Set(["points"]);

// Cards whose entire body is represented by the INPUTS panel + the right-hand visual, so
// the full card component isn't rendered in the left column (output: just a video input +
// its render + ★ mark-final, all shown elsewhere).
const NO_CARD = new Set(["output"]);

interface NodeSettingsModalProps {
  node: GraphNode;
  ctx: NodeCtx;
  onGraphChange: (updater: (g: Graph) => Graph) => void;
  onDetach?: (fluidId: string, key: string) => void;
  onClose: () => void;
}

export default function NodeSettingsModal({
  node,
  ctx,
  onGraphChange,
  onDetach,
  onClose,
}: NodeSettingsModalProps) {
  // ESC closes (same listener shape as AssetLibrary).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The card in the modal must NOT consult the editor's compact set (it would hide its
  // own body — the node IS compact on canvas); an empty set renders it full. The no-op
  // toggle keeps the (CSS-hidden) header button inert. `rename` is unused here (the
  // header field below renames), but kept so the card renders without a provider gap.
  const modalCtx = useMemo(
    () => ({
      minimized: new Set<string>(),
      toggle: () => {},
      rename: (id: string, name: string) => onGraphChange((g) => renameNode(g, id, name)),
    }),
    [onGraphChange]
  );
  // The ctx the CARD gets: flagged so its own inline StreamPreview/ValuePreview render
  // nothing (the right column owns the visual). CompactPreview gets the plain ctx.
  const cardCtx = useMemo<NodeCtx>(() => ({ ...ctx, previewInPanel: true }), [ctx]);

  const base = chromeFor(node.type);
  // Signal cards take their stem's colour (matches the on-canvas card); others use the
  // type accent.
  let accent = base.accent;
  if (node.type === "signal") {
    const sig = (ctx.signals || []).find(
      (s) => s.id === (node.data as { signalId?: string }).signalId
    );
    accent = sig ? stemColor(sig.stemKey) : "var(--muted)";
  }

  // Header name: the card's name (double-click to rename), with the type as a subtitle.
  const displayName = node.name ?? base.title;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // Lyrics window's second tab (line/timestamp editor). Hook lives here (before any early
  // return); whether the tab bar shows is decided below.
  const [tab, setTab] = useState<"layout" | "lyrics">("layout");
  const startEdit = () => {
    setDraft(displayName);
    setEditing(true);
  };
  const commitEdit = () => {
    if (editing) onGraphChange((g) => renameNode(g, node.id, draft));
    setEditing(false);
  };

  const spec = NODE_TYPES[node.type];
  if (!spec) return null;
  const Card = spec.Component;

  // Pure-editor cards (points: its draggable pad IS both visual and control) render
  // single-column — no separate right-hand preview.
  const singleCol = SINGLE_COLUMN.has(node.type);

  // Lyrics gets a second tab to edit the line words + timestamps (folds in the standalone
  // LyricsEditor). Only when the project actually has editable lyric lines.
  const hasTabs = node.type === "lyrics" && !!ctx.onSaveLyricLines;
  const showLyricsTab = hasTabs && tab === "lyrics";

  return createPortal(
    <div
      className="anim-modal-scrim"
      onPointerDown={onClose}
      // The modal is portaled, but React events bubble through the REACT tree — so a
      // wheel here would reach the canvas onWheel and pan it "behind". Swallow it.
      onWheel={(e) => e.stopPropagation()}
    >
      <div
        className={"anim-modal node-settings" + (singleCol ? " single" : "")}
        role="dialog"
        aria-label={`${base.title} settings`}
        onPointerDown={(e) => e.stopPropagation()}
        style={{ "--accent": accent } as CSSProperties}
      >
        <div className="node-settings-head">
          <span className="node-settings-dot" style={{ background: accent }} />
          {editing ? (
            <input
              className="node-settings-name-edit"
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitEdit();
                else if (e.key === "Escape") setEditing(false);
              }}
            />
          ) : (
            <span
              className="node-settings-name"
              title="double-click to rename"
              onDoubleClick={startEdit}
            >
              {displayName}
            </span>
          )}
          <span className="node-settings-type">{base.title}</span>
          {hasTabs && (
            <span className="node-settings-tabs" role="tablist">
              <button
                className={"node-settings-tab" + (tab === "layout" ? " on" : "")}
                onClick={() => setTab("layout")}
              >
                layout
              </button>
              <button
                className={"node-settings-tab" + (tab === "lyrics" ? " on" : "")}
                onClick={() => setTab("lyrics")}
              >
                lyrics
              </button>
            </span>
          )}
          <button
            className="node-settings-close"
            onClick={onClose}
            aria-label="close settings"
            title="close"
          >
            ✕
          </button>
        </div>

        {showLyricsTab ? (
          <div className="node-settings-tab-panel">
            <LyricsLinesEditor
              lines={(ctx.lyricLines || []) as LyricLine[]}
              onSave={ctx.onSaveLyricLines!}
            />
          </div>
        ) : (
          <>
            <div className="node-settings-main">
              {ctx.graph && (
                <InputPicker
                  node={node}
                  graph={ctx.graph}
                  signals={ctx.signals}
                  onGraphChange={onGraphChange}
                />
              )}
              {!NO_CARD.has(node.type) && (
                <MinimizeContext.Provider value={modalCtx}>
                  <Card
                    node={node}
                    selected={false}
                    helpers={STUB_HELPERS}
                    ctx={cardCtx}
                    onGraphChange={onGraphChange}
                    onDetach={onDetach}
                    onDelete={undefined}
                  />
                </MinimizeContext.Provider>
              )}
            </div>

            {!singleCol && (
              <div className="node-settings-visual">
                <SettingsVisual node={node} ctx={ctx} accent={accent} />
              </div>
            )}
          </>
        )}
      </div>
    </div>,
    portalTarget()
  );
}
