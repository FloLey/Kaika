import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import * as api from "../../lib/api";
import { fmtTime } from "../../lib/mel";
import { useRenderJob } from "../../lib/useRenderJob";
import Info from "../../ui/Info";

interface TrimRowProps {
  finalUrl: string; // the finished master (/fluid/...)
  // The stage's preview player — dragging a handle seeks it there, so you pick the
  // cut points by eye on the actual footage.
  videoRef: RefObject<HTMLVideoElement | null>;
  // Swap the stage player onto another file (the finished cut) / back (null) — the
  // "show me what the result will BE" half of the trim.
  onPreviewCut: (url: string | null) => void;
  previewingCut: boolean;
}

// The platform-length trim under a finished master: pick a start and an end on two
// sliders (the preview seeks as you drag), ✂ cut re-encodes just that range
// server-side (frame-accurate, the master's quality), and the cut gets its own
// download button. The master file is untouched — cut as many variants as needed
// (an Instagram reel caps at ~3 minutes; the master is the whole song).
export default function TrimRow({ finalUrl, videoRef, onPreviewCut, previewingCut }: TrimRowProps) {
  const [dur, setDur] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [cut, setCut] = useState<{ url: string; start: number; end: number } | null>(null);
  // The cut job, on the shared long-render contract (persisted id, re-attach on
  // remount, never cancelled by unmounting). `null` storeKey: a trim is cheap to
  // redo and its range lives only in this component, so resuming one across a
  // reload would show progress for a range the sliders no longer agree with.
  const job = useRenderJob(null);
  // The range the in-flight job is cutting — captured at kick-off, because the
  // sliders keep moving while it runs.
  const [pendingRange, setPendingRange] = useState<{ start: number; end: number } | null>(null);
  const busy = job.busy || !!pendingRange;
  const pct =
    job.progress && job.progress.total
      ? Math.round((job.progress.done / job.progress.total) * 100)
      : null;

  // Adopt the finished cut: the hook reports the url, and the range it belongs to
  // is the one captured at kick-off.
  useEffect(() => {
    if (!job.finalUrl || !pendingRange) return;
    setCut({ url: job.finalUrl, ...pendingRange });
    onPreviewCut(job.finalUrl); // the player now SHOWS the result
    setPendingRange(null);
  }, [job.finalUrl, pendingRange, onPreviewCut]);
  useEffect(() => {
    if (!job.error) return;
    setError(job.error);
    setPendingRange(null);
  }, [job.error]);
  // ▶ preview selection: loop the stage player over [start, end] of the MASTER —
  // exactly what the cut will contain, heard and seen before cutting anything.
  const [looping, setLooping] = useState(false);
  const startRef = useRef(start);
  const endRef = useRef(end);
  startRef.current = start;
  endRef.current = end;
  useEffect(() => {
    if (!looping) return;
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => {
      if (v.currentTime >= endRef.current - 0.03 || v.currentTime < startRef.current - 0.25) {
        v.currentTime = startRef.current;
      }
    };
    v.currentTime = startRef.current;
    v.play().catch(() => {});
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, [looping, videoRef]);
  // Leaving for the cut preview (or a fresh master) stops the loop.
  useEffect(() => {
    if (previewingCut) setLooping(false);
  }, [previewingCut]);
  useEffect(() => setLooping(false), [finalUrl]);

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
    onPreviewCut(null); // handles move on MASTER time — leave the cut preview
    seek(Math.min(v, end - 0.5));
  };
  const onEnd = (v: number) => {
    setEnd(Math.max(v, start + 0.5));
    setCut(null);
    onPreviewCut(null);
    seek(Math.max(v, start + 0.5));
  };

  // A fresh cut is a background job (a 4K re-encode runs for minutes). It follows
  // exactly the render contract `useRenderJob` already implements — this used to be
  // a hand-written `for(;;)` loop with its own busy/pct/error state beside the hook
  // that does the same thing, and only this copy could lose a cut by unmounting.
  async function doCut() {
    setError(null);
    setPendingRange({ start, end });
    try {
      const r = await api.trimExport(finalUrl, start, end);
      if (r.url) {
        // Cache hit — the same range was cut before, so there is no job to follow.
        setPendingRange(null);
        setCut({ url: r.url, start, end });
        onPreviewCut(r.url); // the player now SHOWS the result
        return;
      }
      job.start(async () => ({ render_id: r.render_id! }));
    } catch (e) {
      setPendingRange(null);
      setError(e instanceof Error ? e.message : "trim failed");
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
          {previewingCut && <strong>viewing the cut · </strong>}
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
        <button
          className={"btn sm" + (looping ? " on" : "")}
          title="loop the player over the selection — exactly what the cut will contain"
          onClick={() => {
            onPreviewCut(null); // back on the master before looping master times
            setLooping((l) => !l);
          }}
          disabled={busy}
        >
          {looping ? "■ stop" : "▶ preview selection"}
        </button>
        <button className="btn sm" onClick={doCut} disabled={busy || whole}>
          {busy ? `cutting…${pct != null ? ` ${pct}%` : ""}` : "✂ cut"}
        </button>
        {previewingCut && (
          <button
            className="btn sm"
            title="the player is showing the finished cut — switch back to the whole master"
            onClick={() => onPreviewCut(null)}
          >
            ↩ master
          </button>
        )}
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
