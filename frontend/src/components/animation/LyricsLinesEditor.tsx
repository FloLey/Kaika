import { useState } from "react";
import type { ChangeEvent } from "react";
import { fmtTimecode, parseTimecode } from "../../lib/mel";
import type { LyricLine } from "../../lib/types";

// Re-exported for existing importers. The shape now lives in lib/types and mirrors the
// backend dataclass (segment.LyricLine: t0, t1, text, aligned=True) — it used to be
// declared loosely here BECAUSE ctx.lyricLines was `unknown[]` at the boundary, and that
// boundary is now typed.
export type { LyricLine } from "../../lib/types";

interface Props {
  lines: LyricLine[];
  onSave: (lines: LyricLine[]) => Promise<void>;
  onClose?: () => void; // when present, a "cancel" button + close-on-save (the modal shell)
}

// The draft row keeps the timings as the *strings* the user is typing (s0/s1) so a
// half-typed "1:2" isn't clobbered by a controlled numeric value on every keystroke; we
// parse back to seconds at save time (and to flag invalid rows).
interface DraftRow {
  s0: string;
  s1: string;
  text: string;
  aligned?: boolean;
}

// Edit the aligned lyric lines — both their WORDS and their TIMINGS. Extracted from the
// LyricsEditor modal so it can also live inside the lyrics settings window's second tab;
// this component is JUST the content (no scrim / portal / header).
export default function LyricsLinesEditor({ lines, onSave, onClose }: Props) {
  const [draft, setDraft] = useState<DraftRow[]>(() =>
    lines.map((l) => ({
      s0: fmtTimecode(l.t0 ?? 0),
      s1: fmtTimecode(l.t1 ?? 0),
      text: l.text ?? "",
      aligned: l.aligned,
    }))
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const setField = (i: number, patch: Partial<DraftRow>) =>
    setDraft((prev) => prev.map((r, k) => (k === i ? { ...r, ...patch } : r)));

  // Per-row parse: null t0/t1 => unparseable; end-before-start is its own error. Both
  // block the save and light up the offending input.
  const parsed = draft.map((r) => ({ t0: parseTimecode(r.s0), t1: parseTimecode(r.s1) }));
  const rowBad = parsed.map(
    (p) => p.t0 === null || p.t1 === null || (p.t0 as number) > (p.t1 as number)
  );
  const anyBad = rowBad.some(Boolean);

  const dirty = draft.some(
    (r, i) =>
      r.text !== (lines[i]?.text ?? "") ||
      r.s0 !== fmtTimecode(lines[i]?.t0 ?? 0) ||
      r.s1 !== fmtTimecode(lines[i]?.t1 ?? 0)
  );

  const save = async () => {
    if (anyBad) return;
    setBusy(true);
    setErr(null);
    try {
      const out: LyricLine[] = draft.map((r, i) => ({
        t0: parsed[i].t0 as number,
        t1: parsed[i].t1 as number,
        text: r.text,
        ...(r.aligned !== undefined ? { aligned: r.aligned } : {}),
      }));
      await onSave(out);
      onClose?.();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="lyrics-editor-hint">
        Edit the words and the start/end time of each line. Times are <code>m:ss.cc</code>{" "}
        (minutes:seconds, e.g. <code>1:04.20</code>). Tip: for rewritten lyrics, upload the original
        words first so Whisper times them, then swap in your words here.
      </p>
      <div className="lyrics-editor-list">
        {draft.map((r, i) => (
          <div className="lyrics-editor-row" key={i}>
            <span
              className="lyrics-editor-flag"
              title={
                r.aligned === false ? "interpolated timing (not heard)" : "aligned to the vocal"
              }
            >
              {r.aligned === false ? "≈" : "●"}
            </span>
            <input
              className={`lyrics-editor-time${parsed[i].t0 === null ? " bad" : ""}`}
              type="text"
              aria-label="line start time"
              value={r.s0}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setField(i, { s0: e.target.value })}
            />
            <span className="lyrics-editor-dash">–</span>
            <input
              className={`lyrics-editor-time${rowBad[i] ? " bad" : ""}`}
              type="text"
              aria-label="line end time"
              value={r.s1}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setField(i, { s1: e.target.value })}
            />
            <input
              className="lyrics-editor-text"
              type="text"
              aria-label="line text"
              value={r.text}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setField(i, { text: e.target.value })}
            />
          </div>
        ))}
        {draft.length === 0 && (
          <div className="lyrics-editor-empty">
            no lyric lines on this track — add lyrics at upload so Whisper can time them
          </div>
        )}
      </div>
      {anyBad && (
        <div className="anim-output-err">
          check the highlighted times — use <code>m:ss.cc</code> and keep end ≥ start
        </div>
      )}
      {err && <div className="anim-output-err">{err}</div>}
      <div className="lyrics-editor-actions">
        {onClose && (
          <button className="btn sm" onClick={onClose} disabled={busy}>
            cancel
          </button>
        )}
        <button className="btn sm on" onClick={save} disabled={busy || !dirty || anyBad}>
          {busy ? "saving…" : "save lines"}
        </button>
      </div>
    </>
  );
}
