import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { SyntheticEvent } from "react";
import { engine } from "../../lib/audio";
import * as transport from "../../lib/transport";

interface SegLike {
  start: number;
  end: number;
}

interface PlaybackWindow {
  activeSeg: SegLike | null;
  winStart: number;
  winEnd: number;
  segLen: number;
  // ?ui=next — drive the app-wide transport (lib/transport) instead of owning a
  // private <audio>. Same surface either way, so Studio and every card below it are
  // unchanged; what differs is whether leaving the studio stops the music.
  shared?: boolean;
  // The full mix to play. Only read in shared mode — otherwise Studio puts it on
  // the element it renders itself.
  src?: string;
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
export function useStudioPlayback({
  activeSeg,
  winStart,
  winEnd,
  segLen,
  shared = false,
  src,
}: PlaybackWindow) {
  const [allPlaying, setAllPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const [volume, setVolume] = useState(1); // full-mix playback volume (0..1)
  const [, setPlaying] = useState<Set<string>>(() => new Set()); // solo bookkeeping
  const audioEls = useRef(new Map<string, HTMLAudioElement>());
  const refAudio = useRef<HTMLAudioElement>(null); // clean full-mix reference

  // The playhead (seconds within the segment) lives OUTSIDE React state: timeupdate
  // fires ~4×/s and a setState here would re-render the whole studio tree (every
  // SignalCard + the animation canvas) per tick. Only the transport readout cares,
  // so it subscribes narrowly via useSyncExternalStore (see TransportClock).
  const clockRef = useRef(0);
  const clockSubs = useRef(new Set<() => void>());
  const setClock = useCallback((t: number) => {
    clockRef.current = t;
    clockSubs.current.forEach((fn) => fn());
  }, []);
  const subscribeClock = useCallback((fn: () => void) => {
    clockSubs.current.add(fn);
    return () => {
      clockSubs.current.delete(fn);
    };
  }, []);
  const getClockT = useCallback(() => clockRef.current, []);

  // Seek the shared segment clock to `t` seconds within the segment (0..segLen).
  const seek = useCallback(
    (t: number) => {
      const a = refAudio.current;
      if (!a) return;
      const clamped = Math.min(Math.max(t, 0), segLen);
      a.currentTime = winStart + clamped;
      setClock(clamped);
    },
    [winStart, segLen, setClock]
  );

  // Tear down the Web Audio graph when leaving the studio.
  useEffect(
    () => () => {
      engine.reset();
      audioEls.current.clear();
    },
    []
  );

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
    audioEls.current.forEach((el, k) => {
      if (k !== id) el.pause();
    });
    if (refAudio.current) refAudio.current.pause();
  }, []);

  // Play the whole segment once: ONE audio element (the original full mix) is
  // the clock + the sound. Every pulse pad reads this same clock (see SignalCard
  // groupClock), so all pulses animate together with no duplicate/overlapping
  // audio. Toggles play/pause of that single element.
  const playAll = useCallback(() => {
    const ref = refAudio.current;
    if (!ref) return;
    audioEls.current.forEach((el) => el.pause()); // stop any solo band
    if (!ref.paused) {
      ref.pause();
      return;
    }
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
    setClock(0);
  }, [setClock]);

  const onTimeUpdate = useCallback(
    (e: SyntheticEvent<HTMLAudioElement>) => {
      const el = e.currentTarget;
      const ct = el.currentTime;
      if (ct >= winEnd) {
        if (loop) {
          el.currentTime = winStart; // restart the segment
          setClock(0);
        } else {
          el.pause();
          el.currentTime = winEnd;
          setClock(segLen);
        }
        return;
      }
      setClock(Math.max(0, ct - winStart));
    },
    [winEnd, winStart, loop, segLen, setClock]
  );

  // Spread onto the reference <audio> element in Studio.
  const audioProps = {
    onPlay: () => setAllPlaying(true),
    onPause: () => setAllPlaying(false),
    onEnded: () => setAllPlaying(false),
    onTimeUpdate,
  };

  // --- shared mode (?ui=next) -------------------------------------------------
  // Everything below re-implements the SAME surface against `lib/transport`, whose
  // <audio> lives outside the React tree. Hooks run unconditionally either way (the
  // branch is only in what gets returned), so the rule holds.
  const shrState = useSyncExternalStore(
    transport.subscribe,
    transport.snapshot,
    transport.snapshot
  );
  // A ref-shaped view of the shared element: `groupClock` is passed to every card
  // and to useSyncedPlayback as a RefObject, so this has to look like one.
  const sharedRef = useMemo(
    () =>
      ({
        get current() {
          return transport.audioEl();
        },
      }) as React.RefObject<HTMLAudioElement>,
    []
  );
  useEffect(() => {
    if (!shared || !src) return;
    transport.setSource(src);
  }, [shared, src]);
  useEffect(() => {
    if (!shared) return;
    // `reseek` on a window change: entering a segment should start at its head, not
    // wherever the previous segment's playhead happened to sit.
    transport.setWindow(winStart, winEnd, { reseek: true });
  }, [shared, winStart, winEnd]);
  const sharedSeek = useCallback(
    (t: number) => transport.seekSong(winStart + Math.min(Math.max(t, 0), segLen)),
    [winStart, segLen]
  );
  const sharedSolo = useCallback((id: string) => {
    audioEls.current.forEach((el, k) => {
      if (k !== id) el.pause();
    });
    transport.pause(); // a single band must not play over the whole mix
  }, []);

  if (shared) {
    return {
      refAudio: sharedRef,
      audioProps: {}, // the store owns its element's listeners
      allPlaying: shrState.playing,
      subscribeClock: transport.subscribePosition,
      getClockT: transport.positionInWindow,
      volume: shrState.volume,
      setVolume: transport.setVolume,
      loop: shrState.loop,
      setLoop: transport.setLoop,
      seek: sharedSeek,
      playAll: transport.toggle,
      resetTransport: transport.reset,
      registerAudio,
      onPlayingChange,
      handleSolo: sharedSolo,
    };
  }

  return {
    refAudio,
    audioProps,
    allPlaying,
    subscribeClock,
    getClockT,
    volume,
    setVolume,
    loop,
    setLoop,
    seek,
    playAll,
    resetTransport,
    registerAudio,
    onPlayingChange,
    handleSolo,
  };
}
