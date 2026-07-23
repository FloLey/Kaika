import { useEffect, useState } from "react";
import type { RefObject } from "react";
import * as api from "../../lib/api";
import { fmtTime } from "../../lib/mel";
import Info from "../../ui/Info";

interface TrimRowProps {
  finalUrl: string; // the finished master (/fluid/...)
  // The stage's preview player — dragging a handle seeks it there, so you pick the
  // cut points by eye on the actual footage.
  videoRef: RefObject<HTMLVideoElement | null>;
}

// The platform-length trim under a finished master: pick a start and an end on two
// sliders (the preview seeks as you drag), ✂ cut re-encodes just that range
// server-side (frame-accurate, the master's quality), and the cut gets its own
// download button. The master file is untouched — cut as many variants as needed
// (an Instagram reel caps at ~3 minutes; the master is the whole song).
export default function TrimRow({ finalUrl, videoRef }: TrimRowProps) {
  const [dur, setDur] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cut, setCut] = useState<{ url: string; start: number; end: number } | null>(null);

  // The song duration comes from the preview player's metadata (it is the master).
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const sync = () => setDur(v.duration && Number.isFinite(v.duration) ? v.duration : 0);
    if (v.readyState >= 1) sync();
    v.addEventListener("loadedmetadata", sync);
    return () => v.removeEventListener("loadedmetadata", sync);
  }, [videoRef, finalUrl]);
  // A fresh master (or first metadata) re-arms the handles to the whole span.
  useEffect(() => {
    setStart(0);
    setEnd(dur);
    setCut(null);
  }, [dur, finalUrl]);

  const seek = (t: number) => {
    const v = videoRef.current;
    if (v) v.currentTime = t;
  };
  const onStart = (v: number) => {
    setStart(Math.min(v, end - 0.5));
    setCut(null);
    seek(Math.min(v, end - 0.5));
  };
  const onEnd = (v: number) => {
    setEnd(Math.max(v, start + 0.5));
    setCut(null);
    seek(Math.max(v, start + 0.5));
  };

  async function doCut() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.trimExport(finalUrl, start, end);
      setCut({ url: r.url, start, end });
    } catch (e) {
      setError(e instanceof Error ? e.message : "trim failed");
    } finally {
      setBusy(false);
    }
  }

  if (!dur) return null; // metadata not in yet — nothing to trim against

  const kept = end - start;
  const whole = start < 0.05 && end > dur - 0.05;
  return (
    <div className="export-trim">
      <div className="export-trim-head">
        <span className="export-trim-title">✂ trim a cut</span>
        <Info
          section="export"
          text="Cut a shorter clip out of the finished master — e.g. the 3-minute extract an Instagram reel allows. Drag start/end (the preview seeks along), then ✂ cut re-encodes just that range at the master's quality. The master stays untouched; cut as many variants as you like."
        />
        <span className="export-trim-kept">
          {fmtTime(start)} – {fmtTime(end)} · keeps {fmtTime(kept)}
        </span>
      </div>
      <label className="export-trim-slider">
        <span>start</span>
        <input
          type="range"
          min={0}
          max={dur}
          step={0.1}
          value={start}
          onChange={(e) => onStart(parseFloat(e.target.value))}
        />
        <span className="export-trim-t">{fmtTime(start)}</span>
      </label>
      <label className="export-trim-slider">
        <span>end</span>
        <input
          type="range"
          min={0}
          max={dur}
          step={0.1}
          value={end}
          onChange={(e) => onEnd(parseFloat(e.target.value))}
        />
        <span className="export-trim-t">{fmtTime(end)}</span>
      </label>
      <div className="export-trim-actions">
        <button className="btn sm" onClick={doCut} disabled={busy || whole}>
          {busy ? "cutting…" : "✂ cut"}
        </button>
        {whole && !busy && (
          <span className="anim-fx-hint">move a handle first — this is the whole master</span>
        )}
        {error && <span className="anim-output-err">{error}</span>}
        {cut && (
          <a className="btn export-download" href={cut.url} download>
            ⬇ download cut ({fmtTime(cut.start)}–{fmtTime(cut.end)})
          </a>
        )}
      </div>
    </div>
  );
}
