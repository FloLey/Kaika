// Preview sources for video assets.
//
// A card preview must never stream the RAW asset: a phone clip is routinely ~1 GB of
// 4K, and several <video> elements pulling that at once stall the tab (the cards load
// one by one and then sit frozen). `/asset-proxy/<job>/<sha>` serves a 360p copy —
// ~100× smaller — falling back to the original until the backend has transcoded it,
// so this is always safe to use and simply gets lighter. The RENDER always reads the
// original; this is display only.

// `/assets/<job>/<sha>.<ext>` -> `/asset-proxy/<job>/<sha>`. Anything else (a blob:
// url, an already-proxied url, a foreign path) passes through untouched.
export function videoPreviewSrc(url: string | undefined | null): string {
  if (!url) return "";
  const m = /^\/assets\/([^/]+)\/([^/.]+)\.[^/.]+$/.exec(url);
  return m ? `/asset-proxy/${m[1]}/${m[2]}` : url;
}

// `/assets/<job>/<sha>.<ext>` -> its server-side poster frame `<sha>-thumb.jpg`.
// Used wherever a video only needs to be SEEN, not played: the library grid and the
// compact card previews. A playing <video> per card is what a compact canvas can't
// afford — 20 of them re-request their file continuously.
export function videoThumbSrc(url: string | undefined | null): string {
  return url ? url.replace(/\.[^.]+$/, "-thumb.jpg") : "";
}

// The EXCERPT a preview actually plays: `dur` seconds from `start`, cut and cached
// server-side (`/asset-clip`). A few hundred KB, so a canvas full of cards can each
// play their real moving picture. The file already begins AT the in-point, so a
// consumer must not offset into it again.
export const PREVIEW_EXCERPT_SECONDS = 8;

export function videoClipSrc(
  url: string | undefined | null,
  start = 0,
  dur = PREVIEW_EXCERPT_SECONDS
): string {
  if (!url) return "";
  const m = /^\/assets\/([^/]+)\/([^/.]+)\.[^/.]+$/.exec(url);
  if (!m) return url;
  return `/asset-clip/${m[1]}/${m[2]}?start=${Math.max(0, start).toFixed(1)}&dur=${dur.toFixed(1)}`;
}
