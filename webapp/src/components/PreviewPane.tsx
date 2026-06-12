// The live preview: loops the current window's MP4, swaps it when a fresh
// preview job lands, and peeks at the latest simulated frame while a job is
// still running ("it's coming" feedback).
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import HelpLink from "./HelpLink";

interface Props {
  runId: string;
  jobId: string | null;            // current preview job (null = idle)
  version: number;                 // bump to force a video reload
  aspect: number;                  // canvas w/h
  windowLabel: string;
  windowStart: number;             // track time (s) of the clip's first frame
  onJobDone: () => void;
  onHq: () => void;
  onTime: (t: number) => void;     // playhead follow (track seconds)
  onPlaying: (playing: boolean) => void;
  registerVideo: (el: HTMLVideoElement | null) => void;
}

export default function PreviewPane({ runId, jobId, version, aspect,
                                      windowLabel, windowStart, onJobDone,
                                      onHq, onTime, onPlaying,
                                      registerVideo }: Props) {
  const [rendering, setRendering] = useState(false);
  const [stage, setStage] = useState("starting…");
  const [pct, setPct] = useState(0);          // 0..1, -1 = unknown
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [peek, setPeek] = useState<string | null>(null);
  const [hasVideo, setHasVideo] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // watch the running job; show a clear "rendering" state from the moment the
  // job is queued (not just once it reports "running"), and poll the latest
  // simulated frame for progressive feedback.
  useEffect(() => {
    if (!jobId) { setRendering(false); setPeek(null); return; }
    setRendering(true); setStage("starting…"); setPct(-1); setErrMsg(null);
    const ws = api.watchJob(jobId, (j) => {
      if (j.status === "running") {
        setStage(j.stage || "rendering");
        setPct(j.total ? j.done / j.total : -1);
      }
      if (j.status === "done") { setRendering(false); setPeek(null); onJobDone(); }
      if (j.status === "error") { setRendering(false); setErrMsg(j.error || "failed"); }
    });
    const t = window.setInterval(() => {
      setPeek(`${api.posterUrl(runId)}?t=${Date.now()}`);
    }, 700);
    return () => { ws.close(); window.clearInterval(t); };
  }, [jobId, runId]);

  // a fresh preview landed: mount the video, then (re)load it once mounted
  useEffect(() => {
    if (version > 0) setHasVideo(true);
  }, [version]);
  useEffect(() => {
    const v = videoRef.current;
    registerVideo(v);
    if (v && hasVideo) {
      v.playbackRate = 1;          // undo any accidental native speed change
      v.load();
      v.play().catch(() => {});
    }
  }, [version, hasVideo]);         // eslint-disable-line

  return (
    <div className="card preview-pane">
      <div className={`preview-stage${rendering ? " rendering" : ""}`}
        style={{ aspectRatio: String(aspect) }}>
        {hasVideo && (
          <video ref={videoRef} loop controls playsInline
            // The video must never own the keyboard: blur on focus so keys
            // reach the studio shortcuts (capture handler in Studio), and
            // pin the playback rate so a native speed shortcut is undone.
            onFocus={(e) => (e.target as HTMLVideoElement).blur()}
            onRateChange={(e) => {
              const v = e.target as HTMLVideoElement;
              if (v.playbackRate !== 1) v.playbackRate = 1;
            }}
            onTimeUpdate={(e) =>
              onTime(windowStart + (e.target as HTMLVideoElement).currentTime)}
            onPlay={() => onPlaying(true)}
            onPause={() => onPlaying(false)}>
            <source src={`${api.windowPreviewUrl(runId)}?v=${version}`}
              type="video/mp4" />
          </video>
        )}
        {!hasVideo && !rendering && !errMsg && (
          <div className="preview-empty muted">
            move the playhead or edit a parameter —<br />the window preview
            renders here in seconds
          </div>
        )}
        {errMsg && !rendering && (
          <div className="preview-overlay"><span className="err mono">
            render error: {errMsg}</span></div>
        )}
        {rendering && (
          <div className="preview-overlay rendering-overlay">
            {peek && <img src={peek} alt="" />}
            <div className="rendering-card">
              <span className="spinner" />
              <span className="mono">Rendering preview… {stage}</span>
              <div className="render-bar">
                <i style={pct >= 0 ? { width: `${Math.round(pct * 100)}%` }
                                   : { width: "40%" }}
                   className={pct < 0 ? "indeterminate" : ""} />
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="preview-foot">
        <span className="muted mono">
          {rendering ? <span className="render-dot">● rendering…</span>
                     : windowLabel}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <button className="btn ghost slim" onClick={onHq}
            title="render this window at full resolution">HQ window</button>
          <HelpLink anchor="preview" />
        </span>
      </div>
    </div>
  );
}
