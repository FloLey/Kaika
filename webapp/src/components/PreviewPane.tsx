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
  const [stage, setStage] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const [peek, setPeek] = useState<string | null>(null);
  const [hasVideo, setHasVideo] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // watch the running job; poll the latest frame for progressive feedback
  useEffect(() => {
    if (!jobId) { setStage(null); setPeek(null); return; }
    const ws = api.watchJob(jobId, (j) => {
      setStage(j.status === "running" ? j.stage : null);
      setProgress(j.total ? `${j.done}/${j.total}` : "");
      if (j.status === "done") { setStage(null); setPeek(null); onJobDone(); }
      if (j.status === "error") { setStage(`error: ${j.error}`); }
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
      <div className="preview-stage" style={{ aspectRatio: String(aspect) }}>
        {hasVideo && (
          <video ref={videoRef} loop controls playsInline
            // The browser's native video shortcuts (<,> = speed, arrows =
            // seek) otherwise fire whenever the video keeps focus.
            onKeyDown={(e) => e.preventDefault()}
            onTimeUpdate={(e) =>
              onTime(windowStart + (e.target as HTMLVideoElement).currentTime)}
            onPlay={() => onPlaying(true)}
            onPause={() => onPlaying(false)}>
            <source src={`${api.windowPreviewUrl(runId)}?v=${version}`}
              type="video/mp4" />
          </video>
        )}
        {!hasVideo && !stage && (
          <div className="preview-empty muted">
            move the playhead or edit a parameter —<br />the window preview
            renders here in seconds
          </div>
        )}
        {stage && (
          <div className="preview-overlay">
            {peek && <img src={peek} alt="" />}
            <span className="mono">{stage} {progress}</span>
          </div>
        )}
      </div>
      <div className="preview-foot">
        <span className="muted mono">{windowLabel}</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <button className="btn ghost slim" onClick={onHq}
            title="render this window at full resolution">HQ window</button>
          <HelpLink anchor="preview" />
        </span>
      </div>
    </div>
  );
}
