// The live preview: loops the current window's MP4, swaps it when a fresh
// preview job lands, and peeks at the latest simulated frame while a job is
// still running ("it's coming" feedback).
import { useEffect, useRef, useState } from "react";
import { api } from "../api";

interface Props {
  runId: string;
  jobId: string | null;            // current preview job (null = idle)
  version: number;                 // bump to force a video reload
  aspect: number;                  // canvas w/h
  windowLabel: string;
  onJobDone: () => void;
  onHq: () => void;
}

export default function PreviewPane({ runId, jobId, version, aspect,
                                      windowLabel, onJobDone, onHq }: Props) {
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

  useEffect(() => {
    const v = videoRef.current;
    if (v && version > 0) {
      setHasVideo(true);
      v.load();
      v.play().catch(() => {});
    }
  }, [version]);

  return (
    <div className="card preview-pane">
      <div className="preview-stage" style={{ aspectRatio: String(aspect) }}>
        {hasVideo && (
          <video ref={videoRef} loop controls playsInline>
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
        <button className="btn ghost slim" onClick={onHq}
          title="render this window at full resolution">HQ window</button>
      </div>
    </div>
  );
}
