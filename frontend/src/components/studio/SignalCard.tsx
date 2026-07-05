import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties, RefObject } from "react";
import Spectrogram from "./Spectrogram";
import CurveView from "./CurveView";
import PulsePad from "./PulsePad";
import Info from "../../ui/Info";
import Ctl from "../../ui/Ctl";
import { engine } from "../../lib/audio";
import { fmtTime, fmtHz, clamp } from "../../lib/mel";
import { stemColor } from "../../lib/segments";
import { FEATURES, FEATURE_HELP, HELP } from "./signalCatalog";
import { useSignalCurve } from "./useSignalCurve";
import type { Signal, StemInfo } from "../../lib/types";

interface SignalCardProps {
  signal: Signal;
  stems: Record<string, StemInfo>;
  segStart: number;
  segEnd: number;
  duration?: number;
  jobId?: string;
  onChange: (id: string, patch: Partial<Signal>) => void;
  onRemove: (id: string) => void;
  registerAudio: (id: string, el: HTMLAudioElement | null) => void;
  onSolo: (id: string) => void;
  onPlayingChange: (id: string, playing: boolean) => void;
  groupClock?: RefObject<HTMLAudioElement | null>;
  groupPlaying?: boolean;
}

// One signal: a stem + frequency band (drawn on the spectrogram) shaped into a
// curve. Re-extracts (debounced) whenever the band/segment/shaping change.
export default function SignalCard({
  signal,
  stems,
  segStart,
  segEnd,
  duration,
  jobId,
  onChange,
  onRemove,
  registerAudio,
  onSolo,
  onPlayingChange,
  groupClock,
  groupPlaying,
}: SignalCardProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [frac, setFrac] = useState(0);
  const [collapsed, setCollapsed] = useState(true);

  const info: StemInfo = stems[signal.stemKey] || {};
  const sr = info.sr || 44100;
  const nyq = Math.round(sr / 2);
  const color = stemColor(signal.stemKey);
  const winLen = Math.max(0.001, segEnd - segStart);
  // The extracted 0–1 curve, re-extracted (debounced) as the band/segment/shaping change.
  const { curve, loading } = useSignalCurve(signal, jobId, segStart, segEnd, winLen);
  // beat/bar are tempo-locked phases — the frequency band has no effect.
  const bandIgnored = signal.feature === "beat" || signal.feature === "bar";

  const patch = (p: Partial<Signal>) => onChange(signal.id, p);

  // Type a band edge directly; clamp to [0, Nyquist] and keep min <= max.
  const setBandMin = (v: string) =>
    patch({ minHz: Math.min(clamp(parseFloat(v) || 0, 0, nyq), signal.maxHz) });
  const setBandMax = (v: string) =>
    patch({ maxHz: Math.max(clamp(parseFloat(v) || 0, 0, nyq), signal.minHz) });

  const specTrack = {
    specUrl: info.spectrogram || "",
    minHz: signal.minHz,
    maxHz: signal.maxHz,
    fmin: 20,
    fmax: sr / 2,
    color,
  };

  // During "play segment", every pad reads the one shared clock so all pulses move
  // together; otherwise it follows this card's own playback.
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

  function togglePlay() {
    const el = audioRef.current;
    if (!el) return;
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
    if (!el) return;
    if (el.currentTime >= segEnd) {
      el.pause();
      el.currentTime = segEnd;
    }
    setFrac(Math.max(0, Math.min(1, (el.currentTime - segStart) / winLen)));
  }

  function seek(f: number) {
    const el = audioRef.current;
    if (el && isFinite(el.duration)) el.currentTime = segStart + f * winLen;
  }

  // Click-to-seek on the curve: move whichever clock drives the curve's playhead.
  function seekCurve(f: number) {
    const el = (groupPlaying ? groupClock : audioRef)?.current;
    if (el && isFinite(el.duration)) el.currentTime = segStart + f * winLen;
  }

  // The collapsed mini strip and the expanded body draw the SAME curve + pulse (only
  // their wrappers differ), so each is built once here and rendered in both places.
  const curveView = (
    <CurveView
      curve={curve}
      color={color}
      loading={loading}
      audioRef={padClock}
      segStart={segStart}
      winLen={winLen}
      playing={padPlaying}
      onSeek={seekCurve}
    />
  );
  const pulsePad = (
    <PulsePad
      audioRef={padClock}
      curve={curve}
      segStart={segStart}
      winLen={winLen}
      color={color}
      playing={padPlaying}
    />
  );

  return (
    <div
      className={"signal" + (collapsed ? " collapsed" : "")}
      style={{ "--accent": color } as CSSProperties}
    >
      <div className="signal-head">
        <button
          className="iconbtn sm"
          title={collapsed ? "Expand" : "Collapse"}
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? "▸" : "▾"}
        </button>
        <button className="play" onClick={togglePlay}>
          {playing ? "❚❚" : "▶"}
        </button>
        <input
          className="signal-name"
          value={signal.name}
          onChange={(e: ChangeEvent<HTMLInputElement>) => patch({ name: e.target.value })}
          placeholder="signal name"
        />
        <select
          className="signal-feature"
          value={signal.feature}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => patch({ feature: e.target.value })}
          title="What to measure from this band"
        >
          {FEATURES.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>
        <Info text={FEATURE_HELP[signal.feature] || HELP.signal} section="studio-features" />
        {collapsed && (
          <span className="band-chip" title="Frequency band">
            {bandIgnored ? "band n/a" : `${fmtHz(signal.minHz)}–${fmtHz(signal.maxHz)}`}
          </span>
        )}
        {!collapsed && (
          <span className="time">
            {fmtTime(frac * winLen)} / {fmtTime(winLen)}
          </span>
        )}
        {collapsed && (
          <>
            <div className="curve-mini">{curveView}</div>
            <div className="pulse-mini">{pulsePad}</div>
          </>
        )}
        <button className="iconbtn" title="Remove signal" onClick={() => onRemove(signal.id)}>
          ✕
        </button>
      </div>

      {!collapsed && (
        <>
          <div className="band-edit">
            <span className="ctl-label">band</span>
            <input
              type="number"
              className="hz-input"
              value={Math.round(signal.minHz)}
              min={0}
              max={nyq}
              step={10}
              disabled={bandIgnored}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setBandMin(e.target.value)}
            />
            <span className="hz-dash">–</span>
            <input
              type="number"
              className="hz-input"
              value={Math.round(signal.maxHz)}
              min={0}
              max={nyq}
              step={10}
              disabled={bandIgnored}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setBandMax(e.target.value)}
            />
            <span className="hz-unit">Hz</span>
            {bandIgnored && (
              <span className="hz-note">band ignored for {signal.feature} phase</span>
            )}
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
              {curveView}
            </div>
            {pulsePad}
          </div>

          <div className="signal-ctls">
            <Ctl
              label="attack"
              value={signal.attack}
              min={0}
              max={1000}
              step={1}
              onChange={(v: number) => patch({ attack: v })}
              fmt={(v: number) => v + "ms"}
              help={HELP.attack}
            />
            <Ctl
              label="release"
              value={signal.release}
              min={0}
              max={2000}
              step={5}
              onChange={(v: number) => patch({ release: v })}
              fmt={(v: number) => v + "ms"}
              help={HELP.release}
            />
            <Ctl
              label="gamma"
              value={signal.gamma}
              min={0.2}
              max={4}
              step={0.05}
              onChange={(v: number) => patch({ gamma: v })}
              fmt={(v: number) => v.toFixed(2)}
              help={HELP.gamma}
            />
            <Ctl
              label="thresh"
              value={signal.threshold}
              min={0}
              max={0.9}
              step={0.02}
              onChange={(v: number) => patch({ threshold: v })}
              fmt={(v: number) => v.toFixed(2)}
              help={HELP.thresh}
            />
            <Ctl
              label="gain"
              value={signal.gain}
              min={0}
              max={2}
              step={0.05}
              onChange={(v: number) => patch({ gain: v })}
              fmt={(v: number) => v.toFixed(2)}
              help={HELP.gain}
            />
            <Ctl
              label="offset"
              value={signal.offset}
              min={-0.5}
              max={0.5}
              step={0.02}
              onChange={(v: number) => patch({ offset: v })}
              fmt={(v: number) => v.toFixed(2)}
              help={HELP.offset}
            />
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
        onPlay={() => {
          setPlaying(true);
          onPlayingChange(signal.id, true);
        }}
        onPause={() => {
          setPlaying(false);
          onPlayingChange(signal.id, false);
        }}
        onEnded={() => {
          setPlaying(false);
          onPlayingChange(signal.id, false);
        }}
      />
    </div>
  );
}
