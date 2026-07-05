import { useEffect, useState } from "react";
import type { ChangeEvent } from "react";
import { createPortal } from "react-dom";
import { fmtTime } from "../../lib/mel";

// Loose shape on purpose — lines arrive from ctx.lyricLines (unknown[] at the
// boundary; the analysis cache guarantees t0/t1/text in practice).
interface LyricLine {
  t0?: number;
  t1?: number;
  text?: string;
  aligned?: boolean;
}

interface LyricsEditorProps {
  lines: LyricLine[];
  onSave: (lines: LyricLine[]) => Promise<void>;
  onClose: () => void;
}

// Edit the TEXT of the aligned lyric lines while keeping their timings — the
// "rewritten lyrics" flow: upload the original words (Whisper aligns them well),
// then swap each line's words here. Timings are read-only on purpose; alignment
// only works against what is actually sung, so re-timing by hand would fight it.
// Saved lines persist via PUT /projects (analysis cache) and every consumer
// (card preview, render keys, export hash) picks them up immediately.
export default function LyricsEditor({ lines, onSave, onClose }: LyricsEditorProps) {
  const [draft, setDraft] = useState<LyricLine[]>(() => lines.map((l) => ({ ...l })));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // ESC closes (discarding unsaved edits), same as the other modals.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const setText = (i: number, text: string) =>
    setDraft((prev) => prev.map((l, k) => (k === i ? { ...l, text } : l)));

  const dirty = draft.some((l, i) => l.text !== lines[i]?.text);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onSave(draft);
      onClose();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "save failed");
      setBusy(false);
    }
  };

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
        <p className="lyrics-editor-hint">
          Rewrite the words; the timing stays locked to the vocal. (Upload the
          original lyrics first so the alignment is right, then change the text here.)
        </p>
        <div className="lyrics-editor-list">
          {draft.map((l, i) => (
            <label className="lyrics-editor-row" key={i}>
              <span className="lyrics-editor-time" title={l.aligned === false ? "interpolated timing" : "aligned to the vocal"}>
                {fmtTime(l.t0 ?? 0)}–{fmtTime(l.t1 ?? 0)}
              </span>
              <input
                className="lyrics-editor-text"
                type="text"
                value={l.text ?? ""}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setText(i, e.target.value)}
              />
            </label>
          ))}
          {draft.length === 0 && (
            <div className="lyrics-editor-empty">
              no aligned lyrics on this track — add lyrics at upload so Whisper can time them
            </div>
          )}
        </div>
        {err && <div className="anim-output-err">{err}</div>}
        <div className="lyrics-editor-actions">
          <button className="btn sm" onClick={onClose} disabled={busy}>
            cancel
          </button>
          <button className="btn sm on" onClick={save} disabled={busy || !dirty}>
            {busy ? "saving…" : "save lines"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
