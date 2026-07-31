import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import Spectrogram from "./Spectrogram";
import CurveView from "./CurveView";
import PulsePad from "./PulsePad";
import { engine } from "../../lib/audio";
import { clamp } from "../../lib/mel";
import { stemColor } from "../../lib/segments";
import { useSignalCurve } from "./useSignalCurve";
import SignalCardView from "./SignalCardView";
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

  const info: StemInfo = stems[signal.stemKey] || {};
  const sr = info.sr || 44100;
  const nyq = Math.round(sr / 2);
  const color = stemColor(signal.stemKey);
  const winLen = Math.max(0.001, segEnd - segStart);
  // The extracted 0–1 curve, re-extracted (debounced) as the band/segment/shaping change.
  const { curve, loading } = useSignalCurve(signal, jobId, segStart, segEnd, winLen);
  // beat/bar are tempo-locked phases — the frequency band has no effect.
  const bandIgnored = signal.feature === "beat" || signal.feature === "bar";
  // What you HEAR has to match what the card says drives the curve. The card disables
  // the Hz inputs and prints "band ignored" for beat/bar, so filtering the audio by a
  // band the extraction never reads would make play sound like a signal that isn't
  // this one. Full-range there; the stored min/max stay untouched for when the
  // feature is switched back.
  const [playMin, playMax] = bandIgnored ? [0, nyq] : [signal.minHz, signal.maxHz];

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
    engine.setBand(signal.id, playMin, playMax);
  }, [signal.id, playMin, playMax]);

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
      engine.connect(signal.id, el, playMin, playMax, false);
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

  // One element, rendered by whichever layout is active — it carries the band-pass
  // registration, so a layout that forgot it would silently lose solo playback.
  const audioEl = (
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
  );

  const spectrogram = (
    <Spectrogram
      track={specTrack}
      frac={frac}
      onSeek={seek}
      onBandChange={(lo, hi) => patch({ minHz: lo, maxHz: hi })}
      winStart={segStart}
      winEnd={segEnd}
      duration={duration}
    />
  );

  // The layout lives in its own file. The split is deliberate and stays: everything
  // above — the audio element, the band-pass registration, the curve extraction, the
  // shared clock — is the part that is hard to get right, and there is one
  // implementation of it. Merging the two files back together would recreate the
  // 400-line component this came out of.
  return (
    <>
      <SignalCardView
        signal={signal}
        patch={patch}
        onRemove={onRemove}
        color={color}
        nyq={nyq}
        bandIgnored={bandIgnored}
        playing={playing}
        onTogglePlay={togglePlay}
        setBandMin={setBandMin}
        setBandMax={setBandMax}
        spectrogram={spectrogram}
        curveView={curveView}
        pulsePad={pulsePad}
      />
      {audioEl}
    </>
  );
}
