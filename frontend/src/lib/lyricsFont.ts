import { useEffect, useState } from "react";

// Load a bundled lyric font (GET /fonts/<key>) into the browser via the FontFace API so
// the lyrics card can draw a live text preview in the chosen typeface. Cached per key;
// `useLyricsFont` returns the CSS family name once the font is ready (empty until then, so
// callers can fall back to a generic font and redraw when it flips).

const FAMILY = (key: string) => `lyr-${key}`;
const loaded = new Set<string>();
const inflight = new Map<string, Promise<boolean>>();

function ensureFont(key: string): Promise<boolean> {
  if (loaded.has(key)) return Promise.resolve(true);
  let p = inflight.get(key);
  if (!p) {
    // `document.fonts` / FontFace are unavailable in non-DOM test envs — guard it.
    if (typeof document === "undefined" || typeof FontFace === "undefined") {
      return Promise.resolve(false);
    }
    const face = new FontFace(FAMILY(key), `url(/fonts/${encodeURIComponent(key)})`);
    p = face
      .load()
      .then((f) => {
        document.fonts.add(f);
        loaded.add(key);
        return true;
      })
      .catch(() => false);
    inflight.set(key, p);
  }
  return p;
}

export function useLyricsFont(key: string): string {
  const [ready, setReady] = useState(() => !!key && loaded.has(key));
  useEffect(() => {
    if (!key) {
      setReady(false);
      return;
    }
    if (loaded.has(key)) {
      setReady(true);
      return;
    }
    let alive = true;
    setReady(false);
    ensureFont(key).then((ok) => alive && ok && setReady(true));
    return () => {
      alive = false;
    };
  }, [key]);
  return ready && key ? FAMILY(key) : "";
}
