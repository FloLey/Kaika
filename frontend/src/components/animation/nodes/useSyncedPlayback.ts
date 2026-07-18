import { useEffect } from "react";
import type { RefObject } from "react";

// A preview <video>'s two playback modes, shared by every producer preview:
//
//  • idle (segment not playing) — the clip loops on its own (native autoPlay, so the
//    pulse-driven motion stays smooth), but a rAF phase-locks it to ONE shared wall
//    clock so EVERY card's idle loop lines up with every other card's. Otherwise each
//    preview would loop at whatever phase it happened to start rendering at, and two
//    cards (e.g. a source and the echo/transform fed by it) would drift out of sync —
//    obvious the moment a card visibly transforms its input.
//  • previewing (segment playing) — the frame is slaved to the shared segment clock
//    (Studio's refAudio) so the video lines up with the audio + signal pulse pads,
//    and scrubs with the timeline.
//
// Idle looping is mostly declarative (`autoPlay loop` on the element), but we still
// kick play() here + on `canplay` to cover the playing→idle resume, where the src is
// already loaded so the autoPlay attribute won't re-trigger. Switching macOS Spaces /
// tabs backgrounds the page; the browser pauses background <video> and autoPlay won't
// re-fire, so previews come back frozen. A single "we're back" event
// (visibilitychange) isn't reliable across Spaces, so we also poll: if the clip is
// paused while the page is visible, nudge it. play() only runs when visible, so we
// never fight the browser's background pause.
export function useSyncedPlayback(
  videoRef: RefObject<HTMLVideoElement | null>,
  videoUrl: string,
  groupPlaying: boolean | undefined,
  groupClock: RefObject<HTMLAudioElement | null> | undefined,
  segStart: number
): void {
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !videoUrl) return undefined;
    if (!groupPlaying) {
      const play = () => {
        if (document.visibilityState !== "visible") return;
        const p = v.play && v.play();
        if (p && p.catch) p.catch(() => {});
      };
      play();
      v.addEventListener("canplay", play);
      document.addEventListener("visibilitychange", play);
      window.addEventListener("focus", play);
      const watchdog = setInterval(() => {
        if (v.paused) play();
      }, 1000);
      // Phase-lock to a shared wall clock: the clip plays natively (smooth), and we only
      // nudge currentTime when it drifts clearly out of phase. performance.now() is shared
      // across every preview and each segment clip has the same duration, so the target
      // loop position is identical everywhere — the loops line up with each other. The
      // drift is wrap-aware so we don't fight the loop seam (currentTime≈dur vs target≈0).
      let raf = requestAnimationFrame(function lock() {
        const dur = v.duration;
        if (dur && Number.isFinite(dur) && dur > 0 && document.visibilityState === "visible") {
          const target = (performance.now() / 1000) % dur;
          const d = Math.abs(v.currentTime - target);
          if (Math.min(d, dur - d) > 0.1) v.currentTime = target;
        }
        raf = requestAnimationFrame(lock);
      });
      return () => {
        v.removeEventListener("canplay", play);
        document.removeEventListener("visibilitychange", play);
        window.removeEventListener("focus", play);
        clearInterval(watchdog);
        cancelAnimationFrame(raf);
      };
    }
    v.pause();
    let raf: number;
    const sync = () => {
      const a = groupClock && groupClock.current;
      if (a && v.duration) {
        const target = Math.min(Math.max(a.currentTime - segStart, 0), v.duration - 0.001);
        if (Math.abs(v.currentTime - target) > 0.034) v.currentTime = target;
      }
      raf = requestAnimationFrame(sync);
    };
    raf = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(raf);
  }, [videoRef, videoUrl, groupPlaying, groupClock, segStart]);
}
