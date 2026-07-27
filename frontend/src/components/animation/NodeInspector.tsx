// A card's full editing surface: header, the INPUTS panel, the card's own component,
// and one big live visual. Pure and scrim-free, so the same markup can be a modal
// (NodeSettingsModal wraps it in one) or a dock beside the canvas (the editor).
//
// Extracted rather than reimplemented: the two hosts must show the SAME editor, or
// comparing them tells you nothing about which arrangement you prefer. Only the
// wrapper class differs — which is also why the existing `.node-settings …` rules
// (the ones that hide the card's own param rows, ports and header, because the
// INPUTS panel owns them) keep applying to both without being touched.

import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { NODE_TYPES, chromeFor } from "./nodes/registry";
import { renameNode } from "../../lib/graphModel";
import { stemColor } from "../../lib/segments";
import InputPicker from "./InputPicker";
import SettingsVisual from "./nodes/SettingsVisual";
import LyricsLinesEditor, { type LyricLine } from "./LyricsLinesEditor";
import { MinimizeContext } from "./nodes/minimizeContext";
import type { NodeCtx } from "./nodes/nodeProps";
import { STUB_HELPERS } from "./nodes/nodeProps";
import type { Graph, GraphNode } from "../../lib/types";

// Cards whose visual IS their editor (the points pad) render single-column — no
// separate preview panel would add anything.
export const SINGLE_COLUMN = new Set(["points"]);

// Cards whose entire body is represented by the INPUTS panel + the right-hand visual,
// so the full card component isn't rendered in the left column (output: just a video
// input + its render + ★ mark-final, all shown elsewhere).
export const NO_CARD = new Set(["output"]);

export interface NodeInspectorProps {
  node: GraphNode;
  ctx: NodeCtx;
  onGraphChange: (updater: (g: Graph) => Graph) => void;
  onDetach?: (fluidId: string, key: string) => void;
  // Omitted by the dock: there is nothing to close, you just select another card.
  onClose?: () => void;
  className: string;
}

export default function NodeInspector({
  node,
  ctx,
  onGraphChange,
  onDetach,
  onClose,
  className,
}: NodeInspectorProps) {
  // The card here must NOT consult the editor's compact set (it would hide its own
  // body — the node IS compact on canvas); an empty set renders it full. The no-op
  // toggle keeps the (CSS-hidden) header button inert.
  const hostCtx = useMemo(
    () => ({
      minimized: new Set<string>(),
      toggle: () => {},
      rename: (id: string, name: string) => onGraphChange((g) => renameNode(g, id, name)),
    }),
    [onGraphChange]
  );
  // The ctx the CARD gets: flagged so its own inline StreamPreview/ValuePreview render
  // nothing (the visual column owns the picture). SettingsVisual gets the plain ctx.
  const cardCtx = useMemo<NodeCtx>(() => ({ ...ctx, previewInPanel: true }), [ctx]);

  const base = chromeFor(node.type);
  // Signal cards take their stem's colour (matches the on-canvas card); others use
  // the type accent.
  let accent = base.accent;
  if (node.type === "signal") {
    const sig = (ctx.signals || []).find(
      (s) => s.id === (node.data as { signalId?: string }).signalId
    );
    accent = sig ? stemColor(sig.stemKey) : "var(--muted)";
  }

  const displayName = node.name ?? base.title;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // Lyrics' second tab (line/timestamp editor). Hook before any early return.
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

  const singleCol = SINGLE_COLUMN.has(node.type);
  const hasTabs = node.type === "lyrics" && !!ctx.onSaveLyricLines;
  const showLyricsTab = hasTabs && tab === "lyrics";

  return (
    <div
      className={className + (singleCol ? " single" : "")}
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
        {onClose && (
          <button
            className="node-settings-close"
            onClick={onClose}
            aria-label="close settings"
            title="close"
          >
            ✕
          </button>
        )}
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
              <MinimizeContext.Provider value={hostCtx}>
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
  );
}
