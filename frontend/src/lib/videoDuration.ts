// Client-side clip durations, memoized per URL. A hidden <video> loads ONLY the
// metadata (no decode, no playback), so asking for a dozen durations is cheap and
// each URL is fetched once per session. The montage card uses this to flag a slot
// whose clip is too short to fill it; an unknown/unreadable duration resolves to 0,
// which every caller reads as "don't warn".

import { useEffect, useState } from "react";

const known = new Map<string, number>();
const inflight = new Map<string, Promise<number>>();

export function loadVideoDuration(url: string): Promise<number> {
  const hit = known.get(url);
  if (hit !== undefined) return Promise.resolve(hit);
  const pending = inflight.get(url);
  if (pending) return pending;
  const next = new Promise<number>((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    const done = (d: number) => {
      known.set(url, d);
      inflight.delete(url);
      v.removeAttribute("src"); // release the request/decoder slot
      v.load();
      resolve(d);
    };
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : 0);
    v.onerror = () => done(0);
    v.src = url;
  });
  inflight.set(url, next);
  return next;
}

// Durations for a set of clip URLs, filling in as they resolve. Keyed on the joined
// url list, so a card re-render with the same clips never re-requests.
export function useVideoDurations(urls: string[]): Record<string, number> {
  const [map, setMap] = useState<Record<string, number>>({});
  const key = urls.join("|");
  useEffect(() => {
    let alive = true;
    const list = key ? key.split("|") : [];
    Promise.all(list.map((u) => loadVideoDuration(u).then((d) => [u, d] as const))).then(
      (pairs) => {
        if (alive) setMap(Object.fromEntries(pairs));
      }
    );
    return () => {
      alive = false;
    };
    // `key` IS the url list (the effect re-splits it), so the array identity is
    // deliberately not a dep — it changes every render and would refetch each time.
  }, [key]);
  return map;
}
