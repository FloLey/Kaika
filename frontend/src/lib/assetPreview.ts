// How a video asset is DISPLAYED in the editor.
//
// A card preview must never stream the raw asset: a phone clip is routinely ~1 GB of 4K,
// and several <video> elements pulling that at once stall the tab. Three modes, one path
// parse, one rule each:
//
//   thumb  — a poster frame (`<sha>-thumb.jpg`). Anything that only needs to be SEEN:
//            the library grid, a compact card body.
//   clip   — the seconds the preview actually plays, cut server-side (~57 KB). Anything
//            that PLAYS on its own clock: card previews, montage inputs.
//   scrub  — the full 360p proxy, seekable. Only where the user drags through the whole
//            clip: the crop pad and the in-point picker.
//
// The RENDER always reads the original; this is display only.

const ASSET_URL = /^\/assets\/([^/]+)\/([^/.]+)\.[^/.]+$/;

export const PREVIEW_EXCERPT_SECONDS = 8;

export interface PreviewOpts {
  mode: "thumb" | "clip" | "scrub";
  /** `clip` only: where the excerpt starts in the source, seconds. */
  start?: number;
  /** `clip` only: how many seconds to cut. */
  dur?: number;
}

/** The URL to display `url` with. A non-asset url (blob:, foreign path) passes through. */
export function assetSrc(url: string | undefined | null, opts: PreviewOpts): string {
  if (!url) return "";
  const m = ASSET_URL.exec(url);
  if (!m) return url;
  const [, job, sha] = m;
  if (opts.mode === "thumb") return url.replace(/\.[^.]+$/, "-thumb.jpg");
  if (opts.mode === "scrub") return `/asset-proxy/${job}/${sha}`;
  const start = Math.max(0, opts.start ?? 0).toFixed(1);
  const dur = (opts.dur ?? PREVIEW_EXCERPT_SECONDS).toFixed(1);
  return `/asset-clip/${job}/${sha}?start=${start}&dur=${dur}`;
}

export const videoThumbSrc = (url: string | undefined | null): string =>
  assetSrc(url, { mode: "thumb" });
export const videoClipSrc = (url: string | undefined | null, start = 0, dur?: number): string =>
  assetSrc(url, { mode: "clip", start, dur });
export const videoScrubSrc = (url: string | undefined | null): string =>
  assetSrc(url, { mode: "scrub" });
