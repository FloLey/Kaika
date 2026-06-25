import { useEffect, useRef, useState } from "react";
import Spectrogram from "./Spectrogram.jsx";
import CurveView from "./CurveView.jsx";
import PulsePad from "./PulsePad.jsx";
import Info from "../../ui/Info.jsx";
import Ctl from "../../ui/Ctl.jsx";
import { engine } from "../../lib/audio.js";
import { fmtTime, fmtHz, clamp } from "../../lib/mel.js";
import { stemColor } from "../../lib/segments.js";
import { extractSignal } from "../../lib/api.js";

const FPS = 30;

// Feature types (must match signals.py `_RAW`) with a one-line explanation.
const FEATURES = [
  { key: "energy", label: "energy", help: "Loudness of the band over time — the default driver." },
  { key: "onset", label: "onset", help: "A spike on each hit in the band (use release to add the decay). Great for discrete events." },
  { key: "flux", label: "flux", help: "How fast the band is changing — its 'busy-ness'." },
  { key: "brightness", label: "brightness", help: "Where the energy sits in the band (low=dull, high=bright)." },
  { key: "harmonic", label: "harmonic", help: "Tonal/sustained share vs percussive/noisy in the band." },
  { key: "chroma", label: "chroma", help: "Dominant pitch class in the band (stepped) — handy for driving color." },
  { key: "beat", label: "beat phase", help: "A 0→1 ramp locked to each beat (sawtooth). The frequency band is ignored." },
  { key: "bar", label: "bar phase", help: "A 0→1 ramp locked to each 4-beat bar. The frequency band is ignored." },
];
const FEATURE_HELP = Object.fromEntries(FEATURES.map((f) => [f.key, f.help]));

const HELP = {
  signal:
    "A signal = this track's loudness in the chosen frequency band, over this " +
    "segment, shaped into a 0–1 curve that drives the simulation. Drag the band " +
    "edges on the spectrogram; the curve below updates live.",
  attack:
    "How fast the curve RISES when the sound gets louder. Low = snaps up " +
    "instantly on a hit; high = eases up slowly (a gentle swell).",
  release:
    "How fast the curve FALLS when the sound gets quieter. Low = drops " +
    "instantly; high = long smooth tail (e.g. a kick that fades out).",
  gamma:
    "Contrast of the curve. >1 emphasizes peaks (only the loud moments " +
    "register); <1 lifts the quiet detail.",
  thresh:
    "Gate: ignore everything below this level, so the signal reacts only to " +
    "strong hits and not to background.",
  gain: "Scales the whole curve up/down (multiplies the value).",
  offset:
    "Shifts the whole curve up/down (adds a constant) — e.g. so it never " +
    "reaches zero.",
  invert:
    "Flips the curve: loud → low instead of loud → high. Invert + slow attack " +
    "+ fast release = the sidechain pump (drops on the kick, swells between).",
};

// One signal: a stem + frequency band (drawn on the spectrogram) shaped into a
// curve. Re-extracts (debounced) whenever the band/segment/shaping change.
export default function SignalCard({
  signal, stems, segStart, segEnd, duration, jobId,
  onChange, onRemove, registerAudio, onSolo, onPlayingChange,
  groupClock, groupPlaying,
}) {
  const audioRef = useRef(null);
  const [curve, setCurve] = useState([]);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [frac, setFrac] = useState(0);
  const [collapsed, setCollapsed] = useState(true);

  const info = stems[signal.stemKey] || {};
  const sr = info.sr || 44100;
  const nyq = Math.round(sr / 2);
  const color = stemColor(signal.stemKey);
  const winLen = Math.max(0.001, segEnd - segStart);
  // beat/bar are tempo-locked phases — the frequency band has no effect.
  const bandIgnored = signal.feature === "beat" || signal.feature === "bar";

  // Type a band edge directly; clamp to [0, Nyquist] and keep min <= max.
  const setBandMin = (v) =>
    patch({ minHz: Math.min(clamp(parseFloat(v) || 0, 0, nyq), signal.maxHz) });
  const setBandMax = (v) =>
    patch({ maxHz: Math.max(clamp(parseFloat(v) || 0, 0, nyq), signal.minHz) });

  const specTrack = {
    specUrl: info.spectrogram,
    minHz: signal.minHz, maxHz: signal.maxHz,
    fmin: 20, fmax: sr / 2, color,
  };

  const patch = (p) => onChange(signal.id, p);

  // During "play segment", every pad reads the one shared clock (the full-mix
  // reference) so all pulses move together; otherwise it follows this card's own
  // playback.
  const padClock = groupPlaying ? groupClock : audioRef;
  const padPlaying = groupPlaying || playing;

  useEffect(() => {
    registerAudio(signal.id, audioRef.current);
    return () => registerAudio(signal.id, null);
  }, [signal.id, registerAudio]);

  // Live band-pass while listening.
  useEffect(() => {
    engine.setBand(signal.id, signal.minHz, signal.maxHz);
  }, [signal.id, signal.minHz, signal.maxHz]);

  // Park playback at the window start when the segment changes.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.pause();
    if (isFinite(el.duration)) el.currentTime = segStart;
    setFrac(0);
  }, [segStart, segEnd]);

  // Debounced re-extraction of the curve.
  useEffect(() => {
    if (!jobId || winLen <= 0.001) return;
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
  }, [
    jobId, signal.stemKey, signal.minHz, signal.maxHz, signal.feature,
    signal.attack, signal.release, signal.invert, signal.gamma, signal.gain,
    signal.offset, signal.threshold, segStart, segEnd, winLen,
  ]);

  function togglePlay() {
    const el = audioRef.current;
    if (el.currentTime < segStart || el.currentTime >= segEnd - 0.02) {
      el.currentTime = segStart;
    }
    if (el.paused) {
      engine.connect(signal.id, el, signal.minHz, signal.maxHz, false);
      onSolo(signal.id);
      el.play().catch(() => {});
    } else {
      el.pause();
    }
  }

  function onTime() {
    const el = audioRef.current;
    if (el.currentTime >= segEnd) { el.pause(); el.currentTime = segEnd; }
    setFrac(Math.max(0, Math.min(1, (el.currentTime - segStart) / winLen)));
  }

  function seek(f) {
    const el = audioRef.current;
    if (isFinite(el.duration)) el.currentTime = segStart + f * winLen;
  }

  // Click-to-seek on the curve: move whichever clock drives the curve's playhead
  // (the shared full-mix during "play segment", otherwise this card's own audio).
  function seekCurve(f) {
    const el = (groupPlaying ? groupClock : audioRef).current;
    if (el && isFinite(el.duration)) el.currentTime = segStart + f * winLen;
  }

  return (
    <div className={"signal" + (collapsed ? " collapsed" : "")} style={{ "--accent": color }}>
      <div className="signal-head">
        <button
          className="iconbtn sm"
          title={collapsed ? "Expand" : "Collapse"}
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? "▸" : "▾"}
        </button>
        <button className="play" onClick={togglePlay}>{playing ? "❚❚" : "▶"}</button>
        <input
          className="signal-name"
          value={signal.name}
          onChange={(e) => patch({ name: e.target.value })}
          placeholder="signal name"
        />
        <select
          className="signal-feature"
          value={signal.feature}
          onChange={(e) => patch({ feature: e.target.value })}
          title="What to measure from this band"
        >
          {FEATURES.map((f) => (
            <option key={f.key} value={f.key}>{f.label}</option>
          ))}
        </select>
        <Info text={FEATURE_HELP[signal.feature] || HELP.signal} section="studio-features" />
        {collapsed && (
          <span className="band-chip" title="Frequency band">
            {bandIgnored ? "band n/a" : `${fmtHz(signal.minHz)}–${fmtHz(signal.maxHz)}`}
          </span>
        )}
        {!collapsed && (
          <span className="time">{fmtTime(frac * winLen)} / {fmtTime(winLen)}</span>
        )}
        {collapsed && (
          <>
            <div className="curve-mini">
              <CurveView curve={curve} color={color} loading={loading}
                         audioRef={padClock} segStart={segStart} winLen={winLen} playing={padPlaying}
                         onSeek={seekCurve} />
            </div>
            <div className="pulse-mini">
              <PulsePad audioRef={padClock} curve={curve} segStart={segStart}
                        winLen={winLen} color={color} playing={padPlaying} />
            </div>
          </>
        )}
        <button className="iconbtn" title="Remove signal" onClick={() => onRemove(signal.id)}>✕</button>
      </div>

      {!collapsed && (
        <>
          <div className="band-edit">
            <span className="ctl-label">band</span>
            <input
              type="number" className="hz-input" value={Math.round(signal.minHz)}
              min={0} max={nyq} step={10} disabled={bandIgnored}
              onChange={(e) => setBandMin(e.target.value)}
            />
            <span className="hz-dash">–</span>
            <input
              type="number" className="hz-input" value={Math.round(signal.maxHz)}
              min={0} max={nyq} step={10} disabled={bandIgnored}
              onChange={(e) => setBandMax(e.target.value)}
            />
            <span className="hz-unit">Hz</span>
            {bandIgnored && <span className="hz-note">band ignored for {signal.feature} phase</span>}
          </div>
          <div className="signal-body">
            <div className={"signal-graphs" + (bandIgnored ? " band-ignored" : "")}>
              <Spectrogram
                track={specTrack}
                frac={frac}
                onSeek={seek}
                onBandChange={(lo, hi) => patch({ minHz: lo, maxHz: hi })}
                winStart={segStart}
                winEnd={segEnd}
                duration={duration}
              />
              <CurveView curve={curve} color={color} loading={loading}
                     audioRef={padClock} segStart={segStart} winLen={winLen} playing={padPlaying}
                     onSeek={seekCurve} />
            </div>
            <PulsePad
              audioRef={padClock}
              curve={curve}
              segStart={segStart}
              winLen={winLen}
              color={color}
              playing={padPlaying}
            />
          </div>

          <div className="signal-ctls">
            <Ctl label="attack" value={signal.attack} min={0} max={1000} step={1}
                 onChange={(v) => patch({ attack: v })} fmt={(v) => v + "ms"} help={HELP.attack} />
            <Ctl label="release" value={signal.release} min={0} max={2000} step={5}
                 onChange={(v) => patch({ release: v })} fmt={(v) => v + "ms"} help={HELP.release} />
            <Ctl label="gamma" value={signal.gamma} min={0.2} max={4} step={0.05}
                 onChange={(v) => patch({ gamma: v })} fmt={(v) => v.toFixed(2)} help={HELP.gamma} />
            <Ctl label="thresh" value={signal.threshold} min={0} max={0.9} step={0.02}
                 onChange={(v) => patch({ threshold: v })} fmt={(v) => v.toFixed(2)} help={HELP.thresh} />
            <Ctl label="gain" value={signal.gain} min={0} max={2} step={0.05}
                 onChange={(v) => patch({ gain: v })} fmt={(v) => v.toFixed(2)} help={HELP.gain} />
            <Ctl label="offset" value={signal.offset} min={-0.5} max={0.5} step={0.02}
                 onChange={(v) => patch({ offset: v })} fmt={(v) => v.toFixed(2)} help={HELP.offset} />
            <div className="ctl ctl-toggle">
              <button
                className={"btn sm" + (signal.invert ? " on" : "")}
                onClick={() => patch({ invert: !signal.invert })}
              >
                invert {signal.invert ? "on" : "off"}
              </button>
              <Info text={HELP.invert} section="studio-shaping" />
            </div>
          </div>
        </>
      )}

      <audio
        ref={audioRef}
        src={info.audio}
        preload="metadata"
        onTimeUpdate={onTime}
        onPlay={() => { setPlaying(true); onPlayingChange(signal.id, true); }}
        onPause={() => { setPlaying(false); onPlayingChange(signal.id, false); }}
        onEnded={() => { setPlaying(false); onPlayingChange(signal.id, false); }}
      />
    </div>
  );
}
