import { useCallback, useEffect, useRef } from "react";
import type { RefObject } from "react";

// Preserve the playback position as a GROWING preview (or the final clip) swaps the
// <video> src — otherwise every new streamed block would restart the clip from 0. We
// remember the last position and seek back once the new (longer) source has loaded.
//
// `reset()` drops the remembered position: call it when the render starts over from
// scratch (a fresh edit, a new export), where resuming mid-clip would be wrong.
//
// `enabled` gates the RESTORE half. While the segment is playing, `useSyncedPlayback`
// owns `currentTime` outright — it has the real clock — and a restore-on-loadedmetadata
// would be a second, uncoordinated writer racing its drift correction. The two roles
// are disjoint: with the transport stopped there IS no clock, and this is the only
// thing that knows where we were. `save` stays armed either way (it costs nothing and
// keeps the resume-to-idle position warm).
export function usePreservePlayback(
  videoRef: RefObject<HTMLVideoElement | null>,
  videoUrl: string,
  enabled = true
): { reset: () => void } {
  const lastTime = useRef(0);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !videoUrl) return undefined;
    const save = () => {
      if (v.currentTime) lastTime.current = v.currentTime;
    };
    const restore = () => {
      if (lastTime.current > 0 && lastTime.current < v.duration) v.currentTime = lastTime.current;
    };
    v.addEventListener("timeupdate", save);
    if (enabled) v.addEventListener("loadedmetadata", restore);
    return () => {
      v.removeEventListener("timeupdate", save);
      v.removeEventListener("loadedmetadata", restore);
    };
  }, [videoRef, videoUrl, enabled]);

  // Block body, not an expression: an implicit `0` return would be read as an effect
  // cleanup function at the call site.
  return {
    reset: useCallback(() => {
      lastTime.current = 0;
    }, []),
  };
}
