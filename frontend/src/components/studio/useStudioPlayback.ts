import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { engine } from "../../lib/audio";
import * as transport from "../../lib/transport";

interface PlaybackWindow {
  winStart: number;
  winEnd: number;
  segLen: number;
  // The full mix to play.
  src?: string;
}

// The studio's playback surface, over the app-wide transport.
//
// `lib/transport` owns the <audio> element outside the React tree, so the music
// survives leaving the studio and every stage shares one clock. This hook adapts that
// store to what the studio and its cards expect: a segment-relative clock, a ref-shaped
// view of the element for `groupClock`, and the per-signal registry that solo needs.
//
//   const t = useStudioPlayback({ winStart, winEnd, segLen, src });
//
// SignalCard gets t.registerAudio / t.onPlayingChange / t.handleSolo / t.refAudio.
//
// This used to carry a SECOND complete engine — a private <audio>, its own clock with a
// hand-rolled subscription, its own loop-at-the-window logic — selected by a `shared`
// flag. Both arms had to be kept in step by hand for one screen's benefit. The store
// won; ~180 lines went with the flag.
export function useStudioPlayback({ winStart, winEnd, segLen, src }: PlaybackWindow) {
  // Solo bookkeeping. Write-only by design: nothing reads the set, but SignalCard
  // reports into it and the state write is what re-renders the list.
  const [, setPlaying] = useState<Set<string>>(() => new Set());
  const audioEls = useRef(new Map<string, HTMLAudioElement>());

  const state = useSyncExternalStore(transport.subscribe, transport.snapshot, transport.snapshot);

  // A ref-shaped view of the shared element: `groupClock` is passed to every card and
  // to useSyncedPlayback as a RefObject, so this has to look like one.
  const refAudio = useMemo(
    () =>
      ({
        get current() {
          return transport.audioEl();
        },
      }) as React.RefObject<HTMLAudioElement>,
    []
  );

  useEffect(() => {
    if (!src) return;
    transport.setSource(src);
  }, [src]);

  useEffect(() => {
    // `reseek` on a window change: entering a segment should start at its head, not
    // wherever the previous segment's playhead happened to sit.
    transport.setWindow(winStart, winEnd, { reseek: true });
  }, [winStart, winEnd]);

  // Tear down the Web Audio graph when leaving the studio. The transport's element is
  // NOT torn down — it outlives this screen on purpose.
  useEffect(
    () => () => {
      engine.reset();
      audioEls.current.clear();
    },
    []
  );

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

  // Seek the segment clock to `t` seconds within the segment (0..segLen).
  const seek = useCallback(
    (t: number) => transport.seekSong(winStart + Math.min(Math.max(t, 0), segLen)),
    [winStart, segLen]
  );

  // Solo: playing one signal pauses the others, and stops the full mix so a single
  // band can't play on top of the whole segment.
  const handleSolo = useCallback((id: string) => {
    audioEls.current.forEach((el, k) => {
      if (k !== id) el.pause();
    });
    transport.pause();
  }, []);

  return {
    refAudio,
    allPlaying: state.playing,
    // The playhead is deliberately not React state: `timeupdate` fires ~4×/s and a
    // setState here would re-render the whole studio tree (every SignalCard + the
    // animation canvas) per tick. Only the transport readout cares, and it subscribes
    // narrowly (see TransportClock).
    subscribeClock: transport.subscribePosition,
    getClockT: transport.positionInWindow,
    volume: state.volume,
    setVolume: transport.setVolume,
    loop: state.loop,
    setLoop: transport.setLoop,
    seek,
    playAll: transport.toggle,
    resetTransport: transport.reset,
    registerAudio,
    onPlayingChange,
    handleSolo,
  };
}
