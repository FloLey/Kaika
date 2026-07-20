import { useEffect } from "react";
import type { RefObject } from "react";

// A preview <video>'s two playback modes, shared by every producer preview:
//
//  • idle (segment not playing) — the clip loops on its own, but a rAF phase-locks it
//    to ONE shared wall clock so EVERY card's idle loop lines up with every other
//    card's. Otherwise each preview would loop at whatever phase it happened to start
//    rendering at, and two cards (e.g. a source and the echo/transform fed by it)
//    would drift out of sync — obvious the moment a card visibly transforms its input.
//  • previewing (segment playing) — the clip is slaved to the shared segment clock
//    (Studio's refAudio) so it lines up with the audio + signal pulse pads.
//
// In BOTH modes the element genuinely PLAYS and we only steer it. Slaving by SEEK
// alone (what the playing branch used to do: pause() + a currentTime write every
// frame) can never track audio: on long-GOP H.264 each seek re-decodes from the
// previous keyframe, so the picture freezes instead of advancing. Small drift is
// absorbed by playbackRate — invisible, and it never interrupts the decoder.

// ── drift control (playing mode) ─────────────────────────────────────────────
const SOFT_DRIFT_S = 0.04; // ≈1 frame @24fps — below this we're in sync, touch nothing
//                            (writing a rate every frame is its own source of judder)
const HARD_DRIFT_S = 0.3; // beyond this a ±10% nudge would need >3s to catch up, so
//                           pay ONE seek. Well above a keyframe interval, so a normal
//                           render never trips it.
const MAX_RATE_SKEW = 0.1; // ±10%: the largest speed change that stays unnoticeable
const RATE_GAIN = 1.0; // drift(s) → rate delta: 0.1s late ⇒ +10% (then clamped)

// Keep a muted preview actually playing. Switching macOS Spaces / tabs backgrounds the
// page and the browser pauses background <video>; the autoPlay attribute won't re-fire,
// so previews come back frozen. A single "we're back" event isn't reliable across
// Spaces, so we also poll. play() only runs while visible — we never fight the
// browser's own background pause.
function armPlayback(v: HTMLVideoElement) {
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
  return {
    play,
    dispose: () => {
      v.removeEventListener("canplay", play);
      document.removeEventListener("visibilitychange", play);
      window.removeEventListener("focus", play);
      clearInterval(watchdog);
    },
  };
}

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
    const arm = armPlayback(v);

    if (!groupPlaying) {
      // Phase-lock to a shared wall clock: the clip plays natively (smooth), and we only
      // nudge currentTime when it drifts clearly out of phase. performance.now() is shared
      // across every preview and each segment clip has the same duration, so the target
      // loop position is identical everywhere — the loops line up with each other. The
      // drift is wrap-aware so we don't fight the loop seam (currentTime≈dur vs target≈0).
      let raf = requestAnimationFrame(function lock() {
        raf = requestAnimationFrame(lock);
        const dur = v.duration;
        if (dur && Number.isFinite(dur) && dur > 0 && document.visibilityState === "visible") {
          const target = (performance.now() / 1000) % dur;
          const d = Math.abs(v.currentTime - target);
          if (Math.min(d, dur - d) > 0.1) v.currentTime = target;
        }
      });
      return () => {
        arm.dispose();
        cancelAnimationFrame(raf);
      };
    }

    // ── playing: steered by the shared segment clock ─────────────────────────
    let raf = requestAnimationFrame(function sync() {
      // Re-arm FIRST so an early return below can't kill the loop.
      raf = requestAnimationFrame(sync);
      const a = groupClock && groupClock.current;
      if (!a) return;
      // The transport can pause under us (groupPlaying is React state, the element is
      // the truth), e.g. the moment the user hits pause.
      if (a.paused) {
        if (!v.paused) v.pause();
        return;
      }
      const dur = v.duration;
      if (!Number.isFinite(dur) || dur <= 0) {
        if (v.paused) arm.play(); // no metadata yet — just let it roll
        return;
      }
      const target = a.currentTime - segStart;
      // The clip does not contain "now": either we're before this segment, or the file
      // on disk stops short of the playhead (a streamed preview still growing, a clip
      // trimmed shorter than its window). HOLD on the last frame — the frames for now
      // simply don't exist. Letting it run instead would hit the end and, because the
      // element loops, wrap to zero: on screen that reads as the clip restarting in the
      // middle of the segment, which is exactly the "it plays twice from the start"
      // complaint. Freezing is honest; a spurious replay is a lie about the timeline.
      if (target < 0 || target >= dur) {
        if (!v.paused) v.pause();
        if (v.playbackRate !== 1) v.playbackRate = 1;
        return;
      }
      if (v.paused) arm.play(); // back inside the rendered range — resume
      if (v.seeking) return; // never stack seeks: each one restarts the decode
      // Wrap-aware: the segment loops (useStudioPlayback sends the audio back to
      // winStart) and the clip loops natively, so at the seam the two can be a whole
      // duration apart while being visually in sync. Fold into (-dur/2, dur/2].
      let drift = v.currentTime - target; // > 0 ⇒ the video is AHEAD of the audio
      if (drift > dur / 2) drift -= dur;
      else if (drift < -dur / 2) drift += dur;
      const ad = Math.abs(drift);
      if (ad > HARD_DRIFT_S) {
        v.currentTime = target;
        v.playbackRate = 1;
      } else if (ad > SOFT_DRIFT_S) {
        // Ahead ⇒ slow down, behind ⇒ speed up. Proportional and bounded.
        const skew = Math.max(-MAX_RATE_SKEW, Math.min(MAX_RATE_SKEW, -drift * RATE_GAIN));
        v.playbackRate = 1 + skew;
      } else if (v.playbackRate !== 1) {
        v.playbackRate = 1;
      }
    });
    return () => {
      cancelAnimationFrame(raf);
      arm.dispose();
      // Never leak a skewed rate into the idle loop — a card resuming its idle loop at
      // 1.1x would drift out of phase with every other card.
      v.playbackRate = 1;
    };
  }, [videoRef, videoUrl, groupPlaying, groupClock, segStart]);
}
