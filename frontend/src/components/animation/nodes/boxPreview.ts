import type { NodeCtx } from "./nodeProps";
import type { BoxImagePreview, BoxVideoPreview } from "./BoxPad";
import type { ImageData, VideoData } from "../../../lib/types";

// The BoxPad content-preview objects, built from a card's data (+ transport ctx for
// video). Shared by the on-canvas cards AND the settings window's SettingsVisual, so the
// box preview is identical in both places.

// A const speed previews at that rate; a wired (modulated) speed previews at 1× (its
// per-frame curve isn't resolved in the card — the render is authoritative).
export function buildVideoPreview(d: VideoData, ctx?: NodeCtx): BoxVideoPreview | undefined {
  if (!d.assetUrl) return undefined;
  const speedBinding = d.ports?.speed?.binding;
  const speed = speedBinding?.kind === "const" ? Number(speedBinding.value) : 1;
  return {
    src: d.assetUrl,
    fit: d.fit,
    sync: d.sync,
    start: d.start,
    speed,
    loop: d.loop,
    segStart: ctx?.segStart ?? 0,
    crop: { x: d.crop_x ?? 0, y: d.crop_y ?? 0, w: d.crop_w ?? 1, h: d.crop_h ?? 1 },
    clock: ctx?.groupClock,
    playing: !!ctx?.groupPlaying,
  };
}

export function buildImagePreview(d: ImageData): BoxImagePreview | undefined {
  return d.assetUrl ? { src: d.assetUrl, fit: d.fit } : undefined;
}
