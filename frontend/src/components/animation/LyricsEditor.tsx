import { useEffect } from "react";
import { createPortal } from "react-dom";
import { portalTarget } from "../../lib/portalTarget";
import LyricsLinesEditor, { type LyricLine } from "./LyricsLinesEditor";

interface LyricsEditorProps {
  lines: LyricLine[];
  onSave: (lines: LyricLine[]) => Promise<void>;
  onClose: () => void;
}

// The standalone lyric-line editor modal (opened from the on-canvas lyrics card's
// "✎ edit lines"). Just the modal shell — the editing UI lives in LyricsLinesEditor, so
// the same editor also embeds in the lyrics settings window's second tab.
export default function LyricsEditor({ lines, onSave, onClose }: LyricsEditorProps) {
  // ESC closes (discarding unsaved edits), same as the other modals.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="anim-modal-scrim" onPointerDown={onClose}>
      <div
        className="anim-modal lyrics-editor"
        role="dialog"
        aria-label="Edit lyric lines"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="anim-modal-head">
          <span className="anim-modal-title">EDIT LYRIC LINES</span>
          <button className="iconbtn" title="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <LyricsLinesEditor lines={lines} onSave={onSave} onClose={onClose} />
      </div>
    </div>,
    portalTarget()
  );
}
