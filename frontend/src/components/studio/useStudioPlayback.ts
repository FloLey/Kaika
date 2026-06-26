import { useCallback, useEffect, useRef, useState } from "react";
import type { SyntheticEvent } from "react";
import { engine } from "../../lib/audio.js";

interface SegLike { start: number; end: number }

interface PlaybackWindow {
  activeSeg: SegLike | null;
  winStart: number;
  winEnd: number;
  segLen: number;
}

// The studio audio engine + transport, lifted out of the Studio view (spec 02).
// Owns the full-mix reference clock (`refAudio`), the per-signal audio registry
// (`audioEls`), and the play/seek/solo/volume transport. The segment window
// (winStart/winEnd/segLen) is passed in by Studio, which derives it from the
// active segment; everything ephemeral about playback lives here.
//
//   const t = useStudioPlayback({ activeSeg, winStart, winEnd, segLen });
//   <audio ref={t.refAudio} {...t.audioProps} />   // bind the reference element
//
// SignalCard gets t.registerAudio / t.onPlayingChange / t.handleSolo / t.refAudio.
export function useStudioPlayback({ activeSeg, winStart, winEnd, segLen }: PlaybackWindow) {
  const [allPlaying, setAllPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const [volume, setVolume] = useState(1);       // full-mix playback volume (0..1)
  const [clockT, setClockT] = useState(0);       // playhead within the segment (s)
  const [, setPlaying] = useState<Set<string>>(() => new Set());   // solo bookkeeping
  const audioEls = useRef(new Map<string, HTMLAudioElement>());
  const refAudio = useRef<HTMLAudioElement>(null);   // clean full-mix reference

  // Seek the shared segment clock to `t` seconds within the segment (0..segLen).
  const seek = useCallback((t: number) => {
    const a = refAudio.current;
    if (!a) return;
    const clamped = Math.min(Math.max(t, 0), segLen);
    a.currentTime = winStart + clamped;
    setClockT(clamped);
  }, [winStart, segLen]);

  // Tear down the Web Audio graph when leaving the studio.
  useEffect(() => () => { engine.reset(); audioEls.current.clear(); }, []);

  // Volume: scale the full-mix reference element. The transport still runs (the
  // clock advances, so the simulation + pulses keep animating) regardless.
  useEffect(() => {
    if (refAudio.current) refAudio.current.volume = volume;
  }, [volume]);

  const registerAudio = useCallback((id: string, el: HTMLAudioElement | null) => {
    if (el) audioEls.current.set(id, el);
    else audioEls.current.delete(id);
  }, []);

  const onPlayingChange = useCallback((id: string, isPlaying: boolean) => {
    setPlaying((prev) => {
      const next = new Set(prev);
      if (isPlaying) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  // Solo: playing one signal pauses the others — and stops the full-mix
  // "play segment" audio so a single band can't play on top of the whole segment.
  const handleSolo = useCallback((id: string) => {
    audioEls.current.forEach((el, k) => { if (k !== id) el.pause(); });
    if (refAudio.current) refAudio.current.pause();
  }, []);

  // Play the whole segment once: ONE audio element (the original full mix) is
  // the clock + the sound. Every pulse pad reads this same clock (see SignalCard
  // groupClock), so all pulses animate together with no duplicate/overlapping
  // audio. Toggles play/pause of that single element.
  const playAll = useCallback(() => {
    const ref = refAudio.current;
    if (!ref) return;
    audioEls.current.forEach((el) => el.pause());   // stop any solo band
    if (!ref.paused) { ref.pause(); return; }
    const start = activeSeg ? activeSeg.start : 0;
    const begin = () => {
      if (isFinite(ref.duration) && (ref.currentTime < start || ref.currentTime >= winEnd - 0.02)) {
        ref.currentTime = start;
      }
      ref.play().catch(() => {});
    };
    // The full mix is a compressed file; on the first play it may not be buffered
    // yet (the WAV stems are). Wait for it to be playable instead of starting silent.
    if (ref.readyState >= 2) begin();
    else {
      ref.addEventListener("canplay", begin, { once: true });
      ref.load();
    }
  }, [activeSeg, winEnd]);

  // Stop everything and rewind the clock — used when switching segments.
  const resetTransport = useCallback(() => {
    audioEls.current.forEach((el) => el.pause());
    if (refAudio.current) refAudio.current.pause();
    setPlaying(new Set());
    setAllPlaying(false);
    setClockT(0);
  }, []);

  const onTimeUpdate = useCallback((e: SyntheticEvent<HTMLAudioElement>) => {
    const el = e.currentTarget;
    const ct = el.currentTime;
    if (ct >= winEnd) {
      if (loop) {
        el.currentTime = winStart;   // restart the segment
        setClockT(0);
      } else {
        el.pause();
        el.currentTime = winEnd;
        setClockT(segLen);
      }
      return;
    }
    setClockT(Math.max(0, ct - winStart));
  }, [winEnd, winStart, loop, segLen]);

  // Spread onto the reference <audio> element in Studio.
  const audioProps = {
    onPlay: () => setAllPlaying(true),
    onPause: () => setAllPlaying(false),
    onEnded: () => setAllPlaying(false),
    onTimeUpdate,
  };

  return {
    refAudio, audioProps,
    allPlaying, clockT,
    volume, setVolume, loop, setLoop,
    seek, playAll, resetTransport,
    registerAudio, onPlayingChange, handleSolo,
  };
}
