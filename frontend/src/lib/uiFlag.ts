// The `?ui=next` opt-in for UI proposals.
//
// `main.tsx` already branches the whole root on `?doc=`; this is the same idea one
// level down. A UI proposal ships as LIVE code beside the current UI — same project,
// same data, one URL apart — so the two can be compared on real work instead of on a
// mockup, and nothing is deleted until one of them wins.
//
// Read live rather than cached at module load: a test flips it with
// `history.replaceState`, and the flag is only consulted on discrete user gestures
// (a wire drop, a keystroke), never in a hot loop.
export function isNext(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("ui") === "next";
}
