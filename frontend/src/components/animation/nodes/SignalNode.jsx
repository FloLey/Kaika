import { useEffect, useState } from "react";
import NodeFrame, { Port } from "./NodeFrame.jsx";
import CurveView from "../../studio/CurveView.jsx";
import PulsePad from "../../studio/PulsePad.jsx";
import { stemColor, STEM_META } from "../../../lib/segments.js";
import { fmtHz } from "../../../lib/mel.js";
import { extractSignal } from "../../../lib/api.js";

const FPS = 30;
const stemName = (key) => (STEM_META.find((m) => m.key === key) || {}).name || key;

// A read-only mirror of a signal defined in the other tab (01 §3.1 signal). It
// resolves the live signal from the segment's `signals` by `data.signalId`, shows
// its stem chip / feature / band, and a recognizable sparkline (a one-shot,
// debounced extractSignal — the SignalCard pattern, no playback). One `out` port.
// If the signal was deleted, it shows a graceful "missing signal" state.
export default function SignalNode({ node, selected, helpers, ctx, onDelete }) {
  const { signals = [], segment, job, groupClock, groupPlaying } = ctx || {};
  const signal = signals.find((s) => s.id === node.data.signalId) || null;

  const segStart = segment?.start ?? 0;
  const segEnd = segment?.end ?? 0;
  const winLen = Math.max(0.001, segEnd - segStart);
  // `ctx.job` is the job_id string (AnimationCanvas passes the project's `job`,
  // a string — same value SignalCard sends as `job_id`). Tolerate an object form
  // too, in case a caller ever passes the richer job record.
  const jobId = typeof job === "string" ? job : (job?.job_id || job?.jobId || ctx?.jobId);

  const [curve, setCurve] = useState([]);
  const [loading, setLoading] = useState(true);

  // Re-extract only when a field that changes the curve changes (not every render,
  // since `signal` is a fresh object each time we resolve it from the list). A
  // stable JSON key of the extraction inputs gates the debounced one-shot.
  const extractKey = signal
    ? JSON.stringify([
        signal.stemKey, signal.minHz, signal.maxHz, signal.feature,
        signal.attack, signal.release, signal.invert, signal.gamma,
        signal.gain, signal.offset, signal.threshold,
      ])
    : null;

  // Debounced one-shot extraction for the sparkline (same as SignalCard, 220ms).
  useEffect(() => {
    if (!signal || !jobId || winLen <= 0.001) {
      setLoading(false);
      setCurve([]);
      return undefined;
    }
    setLoading(true);
    const t = setTimeout(() => {
      extractSignal({
        job_id: jobId, stem: signal.stemKey,
        start: segStart, end: segEnd,
        minHz: signal.minHz, maxHz: signal.maxHz,
        feature: signal.feature, fps: FPS,
        attack: signal.attack, release: signal.release, invert: signal.invert,
        gamma: signal.gamma, gain: signal.gain, offset: signal.offset,
        threshold: signal.threshold,
      })
        .then((d) => { setCurve(d.curve || []); setLoading(false); })
        .catch(() => { setCurve([]); setLoading(false); });
    }, 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extractKey, jobId, segStart, segEnd, winLen]);

  const color = signal ? stemColor(signal.stemKey) : "var(--muted)";
  const bandIgnored = signal && (signal.feature === "beat" || signal.feature === "bar");

  return (
    <NodeFrame
      node={node}
      title="signal"
      accent={color}
      selected={selected}
      onTitlePointerDown={helpers.onTitlePointerDown}
      onDelete={onDelete}
      sideOut={
        <Port
          kind="out"
          flow="value"
          nodeId={node.id}
          portId="out"
          portRef={helpers.portRef}
          startConnect={helpers.startConnect}
          title="signal out"
        />
      }
    >
      {signal ? (
        <div className="anim-signal">
          <div className="anim-signal-meta">
            <span className="stem-chip" style={{ "--accent": color }}>
              {stemName(signal.stemKey)}
            </span>
            <span className="anim-signal-name">{signal.name}</span>
            <span className="anim-signal-feature">{signal.feature}</span>
          </div>
          <div className="anim-signal-band">
            {bandIgnored
              ? "band n/a"
              : `${fmtHz(signal.minHz)}–${fmtHz(signal.maxHz)}`}
          </div>
          <div className="anim-signal-viz">
            <div className="anim-signal-spark">
              <CurveView
                curve={curve}
                color={color}
                loading={loading}
                audioRef={groupClock}
                segStart={segStart}
                winLen={winLen}
                playing={groupPlaying}
              />
            </div>
            <PulsePad
              audioRef={groupClock}
              curve={curve}
              segStart={segStart}
              winLen={winLen}
              color={color}
              playing={groupPlaying}
            />
          </div>
        </div>
      ) : (
        <div className="anim-signal anim-signal-missing">
          <div className="anim-missing-msg">
            missing signal
            <span className="anim-missing-id">{node.data.label || node.data.signalId}</span>
          </div>
          <div className="anim-missing-hint">re-pick it in the Signals tab, or delete this node.</div>
        </div>
      )}
    </NodeFrame>
  );
}
